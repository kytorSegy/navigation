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

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const app = express();

const PERSISTENT_DATA_DIR = path.join(__dirname, 'database');
const PERSISTENT_UPLOAD_DIR = path.join(PERSISTENT_DATA_DIR, 'uploads');

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(compression());

// =================================================================
// [核心修复] 给静态资源文件夹加上强缓存！
// maxAge: '30d' 意味着浏览器会在本地把图片保存 30 天。
// 切换菜单时直接从内存读取，瞬间秒开，0 延迟！
// =================================================================
app.use('/uploads', express.static(PERSISTENT_UPLOAD_DIR, {
  maxAge: '30d' 
}));

// 静态资源托管
app.use(express.static(path.join(__dirname, 'web/dist'), { index: false }));

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
  }

  const safeExt = ext.length > 8 ? fallbackExt : ext;
  const fileName = `${prefix}_${urlHash}${safeExt}`;
  return { fileName, cachePath: path.join(uploadDir, fileName) };
}

function cacheRemoteFile(url, cachePath, callback, redirectCount = 0) {
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
      return cacheRemoteFile(redirectedUrl, cachePath, callback, redirectCount + 1);
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

  request.setTimeout(10000, () => {
    request.destroy(new Error('request timeout'));
  });

  request.on('error', (err) => callback(err));
}

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
    if (!rel.includes('icon') && !rel.includes('shortcut')) continue;
    try {
      links.push(new URL(hrefMatch[1], siteUrl).toString());
    } catch (e) {
    }
  }
  return Array.from(new Set(links));
}

function buildIconCandidates(iconUrl, siteUrl, callback) {
  const candidates = [];
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

  candidates.push(`${origin}/favicon.ico`);
  candidates.push(`${origin}/apple-touch-icon.png`);

  fetchHtml(siteUrl, (err, html) => {
    if (!err && html) {
      const htmlIcons = extractIconLinksFromHtml(siteUrl, html);
      candidates.unshift(...htmlIcons);
    }
    callback(null, Array.from(new Set(candidates)));
  });
}

function tryCacheIconCandidates(iconCandidates, callback, index = 0) {
  if (!iconCandidates || index >= iconCandidates.length) {
    return callback(new Error('no available icon candidates'));
  }
  const current = iconCandidates[index];
  const { fileName, cachePath } = getCacheFilePath(current, 'icon', '.ico');

  if (fs.existsSync(cachePath)) {
    return callback(null, fileName);
  }

  cacheRemoteFile(current, cachePath, (err) => {
    if (!err) {
      return callback(null, fileName);
    }
    if (fs.existsSync(cachePath)) {
      fs.unlink(cachePath, () => {});
    }
    return tryCacheIconCandidates(iconCandidates, callback, index + 1);
  });
}

// 通用图标代理与缓存
app.get('/api/icon', (req, res) => {
  const iconUrl = (req.query.url || '').trim();
  const siteUrl = (req.query.site || '').trim();
  if ((!iconUrl || !/^https?:\/\//i.test(iconUrl)) && (!siteUrl || !/^https?:\/\//i.test(siteUrl))) {
    return res.status(400).send('参数 url 或 site 至少一个为 http/https 链接');
  }

  buildIconCandidates(iconUrl, siteUrl, (_err, candidates) => {
    tryCacheIconCandidates(candidates, (cacheErr, fileName) => {
      if (!cacheErr && fileName) {
        // [核心修复] 给重定向本身加上 1 年的强缓存，并使用 301 永久重定向
        // 这样浏览器看到 /api/icon?url=xxx 就会直接去读本地缓存的 /uploads/xxx，不再发网络请求
        res.set('Cache-Control', 'public, max-age=31536000');
        return res.redirect(301, `/uploads/${fileName}`);
      }

      const fallbackUrl = candidates && candidates.length > 0 ? candidates[0] : iconUrl;
      if (fallbackUrl) {
        return probeRemoteFile(fallbackUrl, (probeErr) => {
          if (!probeErr) {
            res.set('Cache-Control', 'public, max-age=86400'); // 外部链接缓存 1 天
            return res.redirect(302, fallbackUrl);
          }
          res.set('Cache-Control', 'public, max-age=86400');
          return res.redirect(302, '/default-favicon.png');
        });
      }
      res.set('Cache-Control', 'public, max-age=86400');
      return res.redirect(302, '/default-favicon.png');
    });
  });
});

// 代理下载和缓存背景图接口
app.get('/api/background', (req, res) => {
  const bgUrl = (config.app && config.app.background) || process.env.background || process.env.BACKGROUND || '';

  if (!bgUrl || !bgUrl.startsWith('http')) {
    return res.status(404).send('未配置外部网络背景图');
  }

  const { fileName, cachePath } = getCacheFilePath(bgUrl, 'bg', '.jpg');

  if (fs.existsSync(cachePath)) {
    // [核心修复] 背景图同样增加强缓存
    res.set('Cache-Control', 'public, max-age=31536000');
    return res.redirect(301, `/uploads/${fileName}`);
  }

  cacheRemoteFile(bgUrl, cachePath, (err, _savedPath, statusCode) => {
    if (!err) {
      // [核心修复] 背景图同样增加强缓存
      res.set('Cache-Control', 'public, max-age=31536000');
      return res.redirect(301, `/uploads/${fileName}`);
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

app.get('/api/config', (req, res) => {
  let bgUrl = (config.app && config.app.background) || process.env.background || process.env.BACKGROUND || '';
  if (bgUrl && bgUrl.startsWith('http')) {
    bgUrl = '/api/background'; 
  }
  res.json({
    title: (config.app && config.app.title) || process.env.SITE_TITLE || '我的导航',
    background: bgUrl
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running at http://0.0.0.0:${PORT}`);
  console.log(`Zeabur Health Check should pass now.`);
});
