const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const config = require('./config'); // 引入配置文件

// 引入各个路由模块
const menuRoutes = require('./routes/menu');
const cardRoutes = require('./routes/card');
const uploadRoutes = require('./routes/upload');
const authRoutes = require('./routes/auth');
const adRoutes = require('./routes/ad');
const friendRoutes = require('./routes/friend');
const userRoutes = require('./routes/user');
const compression = require('compression');

// =================================================================
// [新增] 下面这三个是 Node.js 自带的内置模块，无需额外安装
// 我们需要它们来帮助下载网络图片并生成唯一的文件名
// =================================================================
const http = require('http');       // 用于处理 http:// 开头的链接
const https = require('https');     // 用于处理 https:// 开头的链接
const crypto = require('crypto');   // 用于生成一段加密的字符（MD5），用来做文件名

const app = express();
const PERSISTENT_DATA_DIR = '/app/database';
const PERSISTENT_UPLOAD_DIR = path.join(PERSISTENT_DATA_DIR, 'uploads');
const ICON_FETCH_FAILURE_COOLDOWN_MS = 30 * 60 * 1000;
const REMOTE_FETCH_TIMEOUT_MS = 15000;
const REMOTE_FETCH_MAX_RETRIES = 2;
const REMOTE_FETCH_MAX_REDIRECTS = 3;
const iconFetchFailureUntil = new Map();
const iconFetchInProgress = new Set();

// 1. 获取端口：Zeabur 会自动注入 PORT 环境变量，如果没有则使用 3000
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(compression());

// 托管本地的上传文件夹
app.use('/uploads', express.static(PERSISTENT_UPLOAD_DIR));

// 静态资源托管
// 关键点：添加 { index: false } 参数。
// 原因：如果不加这个，访问首页时 express 会直接返回未经修改的 index.html 文件，
// 只有禁用了默认的 index，请求才会继续往下走，进入我们自定义的替换逻辑。
app.use(express.static(path.join(__dirname, 'web/dist'), { index: false }));

// 定义处理 HTML 的核心函数
// 这个函数负责读取 index.html 文件，并将占位符替换为真正的标题
const sendIndexHtml = (res) => {
  const indexPath = path.join(__dirname, 'web/dist', 'index.html');
  
  fs.readFile(indexPath, 'utf8', (err, htmlData) => {
    if (err) {
      console.error('Error reading index.html:', err);
      return res.status(500).send('Server Error');
    }
    
    // 获取标题逻辑：
    // 1. 尝试从 config 中获取 (如果你在 config.js 里配置了)
    // 2. 尝试从环境变量直接获取
    // 3. 都没有则使用默认值 '我的导航'
    const siteTitle = (config.app && config.app.title) || process.env.SITE_TITLE || '我的导航';
    
    // 执行替换：将 HTML 中的 __SITE_TITLE__ 替换为变量值
    const renderedHtml = htmlData.replace('__SITE_TITLE__', siteTitle);
    
    // 发送处理后的 HTML 给浏览器
    res.send(renderedHtml);
  });
};

// 根路径路由
// 当用户访问首页 http://localhost:3000/ 时，执行替换逻辑
app.get('/', (req, res) => {
  sendIndexHtml(res);
});

// 前端路由兜底逻辑 (SPA应用必备)
// 防止刷新页面时 404，将非 API 请求重定向回 index.html
app.use((req, res, next) => {
  if (
    req.method === 'GET' &&
    !req.path.startsWith('/api') &&
    !req.path.startsWith('/uploads') &&
    !fs.existsSync(path.join(__dirname, 'web/dist', req.path))
  ) {
    // 这里不再直接 sendFile，而是调用 sendIndexHtml 进行替换后再发送
    sendIndexHtml(res);
  } else {
    next();
  }
});

// 注册常规 API 路由
app.use('/api/menus', menuRoutes);
app.use('/api/cards', cardRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api', authRoutes);
app.use('/api/ads', adRoutes);
app.use('/api/friends', friendRoutes);
app.use('/api/users', userRoutes);

function ensureUploadDir() {
  if (!fs.existsSync(PERSISTENT_UPLOAD_DIR)) {
    fs.mkdirSync(PERSISTENT_UPLOAD_DIR, { recursive: true });
  }
  return PERSISTENT_UPLOAD_DIR;
}

function getCacheFilePath(url, prefix = 'asset', fallbackExt = '.bin') {
  const uploadDir = ensureUploadDir();
  const urlHash = crypto.createHash('md5').update(url).digest('hex');

  let ext = fallbackExt;
  try {
    const parsedUrl = new URL(url);
    const extname = path.extname(parsedUrl.pathname);
    if (extname) {
      ext = extname.toLowerCase();
    }
  } catch (e) {
    // ignore parse error and keep fallback extension
  }

  const safeExt = ext.length > 8 ? fallbackExt : ext;
  const fileName = `${prefix}_${urlHash}${safeExt}`;
  return { fileName, cachePath: path.join(uploadDir, fileName) };
}

function cacheRemoteFile(url, cachePath, callback, attempt = 0, redirectCount = 0) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (e) {
    return callback(new Error('invalid url'));
  }

  const client = parsedUrl.protocol === 'https:' ? https : http;
  const options = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Nav-Item-IconFetcher/1.0)',
      'Accept': 'image/*,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    },
    family: 4
  };

  const request = client.get(url, options, (response) => {
    const statusCode = response.statusCode || 0;
    const location = response.headers.location;
    if ([301, 302, 303, 307, 308].includes(statusCode) && location && redirectCount < REMOTE_FETCH_MAX_REDIRECTS) {
      response.resume();
      const nextUrl = new URL(location, url).toString();
      return cacheRemoteFile(nextUrl, cachePath, callback, attempt, redirectCount + 1);
    }

    if (statusCode !== 200) {
      response.resume();
      return callback(new Error(`upstream status ${statusCode}`), null, statusCode);
    }

    const file = fs.createWriteStream(cachePath);
    response.pipe(file);

    file.on('finish', () => {
      file.close(() => callback(null, cachePath, 200));
    });

    file.on('error', (err) => {
      fs.unlink(cachePath, () => callback(err));
    });
  });

  request.setTimeout(REMOTE_FETCH_TIMEOUT_MS, () => {
    request.destroy(new Error('request timeout'));
  });

  request.on('error', (err) => {
    if (attempt < REMOTE_FETCH_MAX_RETRIES) {
      const retryDelay = 300 * Math.pow(2, attempt);
      return setTimeout(() => {
        cacheRemoteFile(url, cachePath, callback, attempt + 1, redirectCount);
      }, retryDelay);
    }
    callback(err);
  });
}

// 通用图标代理与缓存：同一 URL 只下载一次，后续直接走本地 uploads
app.get('/api/icon', (req, res) => {
  const iconUrl = (req.query.url || '').trim();
  if (!iconUrl || !/^https?:\/\//i.test(iconUrl)) {
    return res.status(400).send('参数 url 必须是 http/https 链接');
  }

  const { fileName, cachePath } = getCacheFilePath(iconUrl, 'icon', '.ico');
  if (fs.existsSync(cachePath)) {
    return res.redirect(`/uploads/${fileName}`);
  }

  const now = Date.now();
  const failUntil = iconFetchFailureUntil.get(iconUrl) || 0;
  if (failUntil > now) {
    return res.redirect(iconUrl);
  }

  // 不阻塞前端：先让浏览器直接加载远程图标，再在后台尝试缓存到持久卷
  res.redirect(iconUrl);

  if (iconFetchInProgress.has(iconUrl)) {
    return;
  }
  iconFetchInProgress.add(iconUrl);

  const fallbackCandidates = [iconUrl];
  try {
    const originFavicon = new URL('/favicon.ico', iconUrl).toString();
    if (originFavicon !== iconUrl) {
      fallbackCandidates.push(originFavicon);
    }
  } catch (e) {
    // ignore invalid url for fallback generation
  }

  const tryFetchCandidate = (index) => {
    const candidateUrl = fallbackCandidates[index];
    if (!candidateUrl) {
      iconFetchInProgress.delete(iconUrl);
      iconFetchFailureUntil.set(iconUrl, Date.now() + ICON_FETCH_FAILURE_COOLDOWN_MS);
      return;
    }

    cacheRemoteFile(candidateUrl, cachePath, (err) => {
      if (!err) {
        iconFetchInProgress.delete(iconUrl);
        iconFetchFailureUntil.delete(iconUrl);
        return;
      }

      if (fs.existsSync(cachePath)) {
        fs.unlink(cachePath, () => {});
      }

      if (index + 1 < fallbackCandidates.length) {
        return tryFetchCandidate(index + 1);
      }

      iconFetchInProgress.delete(iconUrl);
      iconFetchFailureUntil.set(iconUrl, Date.now() + ICON_FETCH_FAILURE_COOLDOWN_MS);
      const errCode = err && err.code ? err.code : 'UNKNOWN';
      console.warn(`图标后台缓存失败，${ICON_FETCH_FAILURE_COOLDOWN_MS / 60000} 分钟后重试: ${errCode} ${iconUrl}`);
    });
  };

  tryFetchCandidate(0);
});


// =================================================================
// [新增部分]：代理下载和缓存背景图的专属接口
// =================================================================
app.get('/api/background', (req, res) => {
  // 1. 先去拿到用户配置的外部图片链接
  const bgUrl = (config.app && config.app.background) || process.env.background || process.env.BACKGROUND || '';

  // 2. 检查：如果根本没配置链接，或者配置的不是网址（比如填错成了其他字符），直接返回错误
  if (!bgUrl || !bgUrl.startsWith('http')) {
    return res.status(404).send('未配置外部网络背景图');
  }

  const { fileName, cachePath } = getCacheFilePath(bgUrl, 'bg', '.jpg');

  // 5. 核心逻辑：检查服务器本地硬盘里有没有这个文件？
  if (fs.existsSync(cachePath)) {
    // 【情况 A：以前已经下载过了】
    // 直接把请求指向我们本地已经存好的图片，速度非常快！
    return res.redirect(`/uploads/${fileName}`);
  }

  cacheRemoteFile(bgUrl, cachePath, (err, _savedPath, statusCode) => {
    if (!err) {
      return res.redirect(`/uploads/${fileName}`);
    }
    if (fs.existsSync(cachePath)) {
      fs.unlink(cachePath, () => {});
    }
    if (statusCode) {
      return res.status(statusCode).send('从网络下载背景图失败');
    }
    console.error('下载背景图时遇到网络错误:', err);
    return res.redirect(bgUrl);
  });
});


// =================================================================
// [修改部分]：拦截并修改给前端的配置信息
// =================================================================
app.get('/api/config', (req, res) => {
  // 第一步：还是先获取原本配置的背景图内容
  let bgUrl = (config.app && config.app.background) || process.env.background || process.env.BACKGROUND || '';

  // 第二步：偷偷把网址替换掉
  // 如果发现系统里配置的是一段外部的网络链接（以 http 开头）
  // 那么我们就不把原链接给浏览器了，而是把我们刚刚写好的缓存接口（/api/background）发给它
  if (bgUrl && bgUrl.startsWith('http')) {
    bgUrl = '/api/background'; 
  }

  // 最后把修改好的配置发给前端去渲染
  res.json({
    title: (config.app && config.app.title) || process.env.SITE_TITLE || '我的导航',
    background: bgUrl
  });
});

// ---------------------------------------------------------
// 核心修复部分：修改监听方式
// ---------------------------------------------------------

// 参数说明：
// 1. PORT: 端口号
// 2. '0.0.0.0': [重要] 显式指定监听所有网络接口，而不仅仅是 localhost
// 3. callback: 启动成功后的回调
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running at http://0.0.0.0:${PORT}`);
  console.log(`Zeabur Health Check should pass now.`);
});
