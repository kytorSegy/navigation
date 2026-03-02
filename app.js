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

// 1. 获取端口：Zeabur 会自动注入 PORT 环境变量，如果没有则使用 3000
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(compression());

// 托管本地的上传文件夹
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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

  // 3. 找个地方存图片：确保项目里的 uploads 文件夹存在，没有的话就自动创建一个
  const uploadDir = path.join(__dirname, 'uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
  }

  // 4. 给图片起个名字：利用图片的网址生成一段独一无二的 MD5 字符
  // 这样只要图片链接不换，名字就一直是一样的，方便我们判断是否下载过
  const urlHash = crypto.createHash('md5').update(bgUrl).digest('hex');
  
  // 简单获取一下图片的格式（比如 .jpg 还是 .png），如果解析失败就默认当成 .jpg
  let ext = '.jpg';
  try {
    const parsedUrl = new URL(bgUrl);
    const extname = path.extname(parsedUrl.pathname);
    if (extname) ext = extname;
  } catch (e) {
    // 解析网址出错时，保持默认的 .jpg
  }
  
  // 最终保存在服务器里的文件名，类似于：bg_8a2b3c4d5e6f.jpg
  const fileName = `bg_${urlHash}${ext}`;
  // 最终保存在服务器里的完整绝对路径
  const cachePath = path.join(uploadDir, fileName);

  // 5. 核心逻辑：检查服务器本地硬盘里有没有这个文件？
  if (fs.existsSync(cachePath)) {
    // 【情况 A：以前已经下载过了】
    // 直接把请求指向我们本地已经存好的图片，速度非常快！
    return res.redirect(`/uploads/${fileName}`);
  }

  // 【情况 B：本地没找到，说明是第一次访问，需要去外网下载】
  // 判断链接是 https 还是 http，选择对应的下载工具
  const client = bgUrl.startsWith('https') ? https : http;

  // 开始去外网请求这个图片
  client.get(bgUrl, (response) => {
    // 状态码 200 代表请求成功
    if (response.statusCode === 200) {
      // 准备好一个空文件，准备往里面写数据
      const file = fs.createWriteStream(cachePath);
      // 把网络上一点点流过来的数据，直接灌进本地文件里
      response.pipe(file);

      // 监听 "完成" 事件，当图片全部写进硬盘后执行：
      file.on('finish', () => {
        file.close(); // 关掉文件流，释放内存
        // 下载完成后，赶紧告诉前端：去本地的 /uploads 文件夹拿图吧！
        res.redirect(`/uploads/${fileName}`);
      });
    } else {
      // 如果去外网没请求到图片（比如链接失效了）
      res.status(response.statusCode).send('从网络下载背景图失败');
    }
  }).on('error', (err) => {
    console.error('下载背景图时遇到网络错误:', err);
    // 万一服务器由于某些原因下载不了，为了不让页面彻底变成白底，
    // 我们做一个备选方案：直接把原本的网络链接丢给浏览器，让浏览器自己去尝试加载
    res.redirect(bgUrl);
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
