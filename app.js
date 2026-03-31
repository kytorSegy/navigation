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
// 引入 Node.js 内置模块
// =================================================================
const http = require('http');       // 用于处理 http:// 的网络请求
const https = require('https');     // 用于处理 https:// 的网络请求
const crypto = require('crypto');   // 用于生成唯一的 MD5 文件名
const { URL } = require('url');     // 用于解析网址

const app = express();

// =================================================================
// [核心修改] 动态获取数据库和上传文件夹的路径 (兼容本地和 Zeabur)
// __dirname 代表当前 app.js 所在的目录。
// 如果在 Zeabur，__dirname 就是 /app，那么拼出来就是 /app/database/uploads
// 如果在你本地，它就是你项目文件夹里的 database/uploads
// =================================================================
const PERSISTENT_DATA_DIR = path.join(__dirname, 'database');
const PERSISTENT_UPLOAD_DIR = path.join(PERSISTENT_DATA_DIR, 'uploads');

// 1. 获取端口：Zeabur 会自动注入 PORT 环境变量，如果没有则使用 3000
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(compression());

// 将持久化文件夹作为静态资源挂载出去，前端访问 /uploads/xxx 就能看到图片
app.use('/uploads', express.static(PERSISTENT_UPLOAD_DIR));

// 静态资源托管，用于前端打包后的文件
app.use(express.static(path.join(__dirname, 'web/dist'), { index: false }));

// 定义处理 HTML 的核心函数（替换首页标题）
const sendIndexHtml = (res) => {
  const indexPath = path.join(__dirname, 'web/dist', 'index.html');
  
  fs.readFile(indexPath, 'utf8', (err, htmlData) => {
    if (err) {
      console.error('Error reading index.html:', err);
      return res.status(500).send('Server Error');
    }
    const siteTitle = (config.app && config.app.title) || process.env.SITE_TITLE || '我的导航';
    const renderedHtml = htmlData.replace('__SITE_TITLE__', siteTitle);
    res.send(renderedHtml);
  });
};

app.get('/', (req, res) => {
  sendIndexHtml(res);
});

// 前端路由兜底逻辑 (SPA应用必备)
app.use((req, res, next) => {
  if (
    req.method === 'GET' &&
    !req.path.startsWith('/api') &&
    !req.path.startsWith('/uploads') &&
    !fs.existsSync(path.join(__dirname, 'web/dist', req.path))
  ) {
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

// =================================================================
// 工具函数区：处理文件夹创建、图片下载和缓存
// =================================================================

// 确保上传文件夹存在，没有就创建一个
function ensureUploadDir() {
  if (!fs.existsSync(PERSISTENT_UPLOAD_DIR)) {
    fs.mkdirSync(PERSISTENT_UPLOAD_DIR, { recursive: true });
  }
  return PERSISTENT_UPLOAD_DIR;
}

// 根据网址生成一个独一无二的本地文件路径
function getCacheFilePath(url, prefix = 'asset', fallbackExt = '.bin') {
  const uploadDir = ensureUploadDir();
  // 把长长的网址变成 md5 字符串
  const urlHash = crypto.createHash('md5').update(url).digest('hex');

  let ext = fallbackExt;
  try {
    const parsedUrl = new URL(url);
    const extname = path.extname(parsedUrl.pathname);
    if (extname) {
      ext = extname.toLowerCase();
    }
  } catch (e) {
    // 解析失败就用默认后缀
  }

  // 防止后缀名太奇怪，做个保护
  const safeExt = ext.length > 8 ? fallbackExt : ext;
  const fileName = `${prefix}_${urlHash}${safeExt}`;
  return { fileName, cachePath: path.join(uploadDir, fileName) };
}

// 核心下载函数：去别的网站把图片下载到服务器硬盘里
function cacheRemoteFile(url, cachePath, callback, redirectCount = 0) {
  const MAX_REDIRECTS = 5; // 最多允许网页重定向 5 次
  const client = url.startsWith('https') ? https : http;
  
  // 伪装成浏览器去请求别人，防止被拦截
  const request = client.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; nav-item/1.0; +https://github.com/eooce/nav-item)',
      'Accept': 'image/*,*/*;q=0.8'
    }
  }, (response) => {
    const statusCode = response.statusCode || 0;
    const location = response.headers.location;
    const isRedirect = [301, 302, 303, 307, 308].includes(statusCode);

    // 遇到重定向（网址跳转），继续追过去下
    if (isRedirect && location) {
      if (redirectCount >= MAX_REDIRECTS) {
        response.resume(); // 释放内存
        return callback(new Error('too many redirects'), null, 508);
      }
      const redirectedUrl = new URL(location, url).toString();
      response.resume();
      return cacheRemoteFile(redirectedUrl, cachePath, callback, redirectCount + 1);
    }

    if (statusCode !== 200) {
      response.resume();
      return callback(new Error(`upstream status ${statusCode}`), null, statusCode);
    }

    // 状态 200，说明成功拿到了图片，开始往本地写文件
    const file = fs.createWriteStream(cachePath);
    response.pipe(file);

    file.on('finish', () => {
      file.close(() => callback(null, cachePath, 200));
    });

    file.on('error', (err) => {
      fs.unlink(cachePath, () => callback(err)); // 出错就把没下完的坏文件删掉
    });
  });

  // 设置 10 秒超时，如果对方服务器卡死，我们就强行中断
  request.setTimeout(10000, () => {
    request.destroy(new Error('request timeout'));
  });

  request.on('error', (err) => callback(err));
}

// 试探性请求：只检查链接能不能通，不下载
function probeRemoteFile(url, callback, redirectCount = 0) {
  const MAX_REDIRECTS = 5;
  const client = url.startsWith('https') ? https : http;
  const request = client.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; nav-item/1.0; +https://github.com/eooce/nav-item)',
      'Accept': 'image/*,*/*;q=0.8'
    }
  }, (response) => {
    const statusCode = response.statusCode || 0;
    const location = response.headers.location;
    const isRedirect = [301, 302, 303, 307, 308].includes(statusCode);

    if (isRedirect && location) {
      if (redirectCount >= MAX_REDIRECTS) {
        response.resume();
        return callback(new Error('too many redirects'), null, 508);
      }
      const redirectedUrl = new URL(location, url).toString();
      response.resume();
      return probeRemoteFile(redirectedUrl, callback, redirectCount + 1);
    }

    response.resume();
    if (statusCode === 200) {
      return callback(null, url, 200);
    }
    return callback(new Error(`upstream status ${statusCode}`), null, statusCode);
  });

  request.setTimeout(10000, () => {
    request.destroy(new Error('request timeout'));
  });
  request.on('error', (err) => callback(err));
}

// 获取网页 HTML 源代码
function fetchHtml(url, callback, redirectCount = 0) {
  const MAX_REDIRECTS = 5;
  const client = url.startsWith('https') ? https : http;
  const request = client.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; nav-item/1.0; +https://github.com/eooce/nav-item)',
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
    }
  }, (response) => {
    const statusCode = response.statusCode || 0;
    const location = response.headers.location;
    const isRedirect = [301, 302, 303, 307, 308].includes(statusCode);

    if (isRedirect && location) {
      if (redirectCount >= MAX_REDIRECTS) {
        response.resume();
        return callback(new Error('too many redirects'), null);
      }
      const redirectedUrl = new URL(location, url).toString();
      response.resume();
      return fetchHtml(redirectedUrl, callback, redirectCount + 1);
    }

    if (statusCode !== 200) {
      response.resume();
      return callback(new Error(`upstream status ${statusCode}`), null);
    }

    let raw = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      raw += chunk;
      // 限制只读取前 512KB 数据，图标都在 HTML 头部，读多了浪费内存
      if (raw.length > 512 * 1024) {
        response.destroy();
      }
    });
    response.on('end', () => callback(null, raw));
    response.on('error', (err) => callback(err));
  });

  request.setTimeout(10000, () => {
    request.destroy(new Error('request timeout'));
  });
  request.on('error', (err) => callback(err));
}

// 从 HTML 里提取 <link rel="icon"> 等标签里的图标链接
function extractIconLinksFromHtml(siteUrl, html) {
  const links = [];
  const reg = /<link\b[^>]*>/gi;
  const hrefReg = /\bhref\s*=\s*["']([^"']+)["']/i;
  const relReg = /\brel\s*=\s*["']([^"']+)["']/i;

  const matches = html.match(reg) || [];
  for (const tag of matches) {
    const hrefMatch = tag.match(hrefReg);
    if (!hrefMatch || !hrefMatch[1]) continue;
    const relMatch = tag.match(relReg);
    const rel = (relMatch && relMatch[1] ? relMatch[1].toLowerCase() : '');
    // 寻找包含 icon 或 shortcut 关键字的链接
    if (!rel.includes('icon') && !rel.includes('shortcut')) continue;
    try {
      links.push(new URL(hrefMatch[1], siteUrl).toString());
    } catch (e) {
      // 忽略无效链接
    }
  }
  return Array.from(new Set(links)); // 去重
}

// 汇总各种找图标的策略
function buildIconCandidates(iconUrl, siteUrl, callback) {
  const candidates = [];
  // 1. 优先使用配置的 logo
  if (iconUrl && /^https?:\/\//i.test(iconUrl)) {
    candidates.push(iconUrl);
  }

  if (!siteUrl || !/^https?:\/\//i.test(siteUrl)) {
    return callback(null, Array.from(new Set(candidates)));
  }

  let origin = '';
  try {
    origin = new URL(siteUrl).origin;
  } catch (e) {
    return callback(null, Array.from(new Set(candidates)));
  }

  // 2. 盲猜网站根目录的两个标准图标路径
  candidates.push(`${origin}/favicon.ico`);
  candidates.push(`${origin}/apple-touch-icon.png`);

  // 3. 去网站主页抓取 HTML 代码，分析里面藏的图标
  fetchHtml(siteUrl, (err, html) => {
    if (!err && html) {
      const htmlIcons = extractIconLinksFromHtml(siteUrl, html);
      candidates.unshift(...htmlIcons); // 把网页里写明的图标放到最前面优先尝试
    }
    callback(null, Array.from(new Set(candidates)));
  });
}

// 挨个尝试下载图标，成功一个就停止
function tryCacheIconCandidates(iconCandidates, callback, index = 0) {
  if (!iconCandidates || index >= iconCandidates.length) {
    return callback(new Error('no available icon candidates'));
  }
  const current = iconCandidates[index];
  const { fileName, cachePath } = getCacheFilePath(current, 'icon', '.ico');

  // 如果本地已经存在，直接返回
  if (fs.existsSync(cachePath)) {
    return callback(null, fileName);
  }

  // 开始尝试下载
  cacheRemoteFile(current, cachePath, (err) => {
    if (!err) {
      return callback(null, fileName); // 下载成功！
    }
    if (fs.existsSync(cachePath)) {
      fs.unlink(cachePath, () => {}); // 失败了清理残骸
    }
    // 递归：当前这个下载失败，去试下一个
    return tryCacheIconCandidates(iconCandidates, callback, index + 1);
  });
}

// =================================================================
// 核心接口 1：通用图标代理与缓存
// =================================================================
app.get('/api/icon', (req, res) => {
  const iconUrl = (req.query.url || '').trim();
  const siteUrl = (req.query.site || '').trim();
  if ((!iconUrl || !/^https?:\/\//i.test(iconUrl)) && (!siteUrl || !/^https?:\/\//i.test(siteUrl))) {
    return res.status(400).send('参数 url 或 site 至少一个为 http/https 链接');
  }

  // 构建寻找图标的策略库并开始尝试
  buildIconCandidates(iconUrl, siteUrl, (_err, candidates) => {
    tryCacheIconCandidates(candidates, (cacheErr, fileName) => {
      // 成功缓存到本地了，通知浏览器去本地看
      if (!cacheErr && fileName) {
        return res.redirect(`/uploads/${fileName}`);
      }

      // 如果所有下载策略都失败了，最后兜底：把原链接丢给浏览器自己试
      const fallbackUrl = candidates && candidates.length > 0 ? candidates[0] : iconUrl;
      if (fallbackUrl) {
        return probeRemoteFile(fallbackUrl, (probeErr) => {
          if (!probeErr) return res.redirect(fallbackUrl);
          // 真的不行了，展示默认灰色地球图标
          return res.redirect('/default-favicon.png');
        });
      }
      return res.redirect('/default-favicon.png');
    });
  });
});

// =================================================================
// 核心接口 2：代理下载和缓存背景图
// =================================================================
app.get('/api/background', (req, res) => {
  const bgUrl = (config.app && config.app.background) || process.env.background || process.env.BACKGROUND || '';

  if (!bgUrl || !bgUrl.startsWith('http')) {
    return res.status(404).send('未配置外部网络背景图');
  }

  const { fileName, cachePath } = getCacheFilePath(bgUrl, 'bg', '.jpg');

  // 如果硬盘里有背景图，直接给前端
  if (fs.existsSync(cachePath)) {
    return res.redirect(`/uploads/${fileName}`);
  }

  // 否则去外网下载背景图
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
// 接口 3：配置项提供（拦截修改背景图）
// =================================================================
app.get('/api/config', (req, res) => {
  let bgUrl = (config.app && config.app.background) || process.env.background || process.env.BACKGROUND || '';

  // 如果原本是网络链接，偷偷替换成我们的代理下载接口
  if (bgUrl && bgUrl.startsWith('http')) {
    bgUrl = '/api/background'; 
  }

  res.json({
    title: (config.app && config.app.title) || process.env.SITE_TITLE || '我的导航',
    background: bgUrl
  });
});

// ---------------------------------------------------------
// 启动服务器
// ---------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running at http://0.0.0.0:${PORT}`);
  console.log(`Zeabur Health Check should pass now.`);
});
