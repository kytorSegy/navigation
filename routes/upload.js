const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();

// [核心修改] 使用 path.join 确保路径兼容性
// 因为这个文件在 routes 目录里，所以用 ../ 退回到上一层（项目根目录），然后进入 database/uploads
const persistentUploadDir = path.join(__dirname, '../database/uploads');

// 检查该目录是否存在，如果没有则创建（ recursive: true 意思是连带父目录一起建）
if (!fs.existsSync(persistentUploadDir)) {
  fs.mkdirSync(persistentUploadDir, { recursive: true });
}

// 配置 Multer 文件上传引擎
const storage = multer.diskStorage({
  // 决定文件要存在服务器的哪个文件夹
  destination: function (req, file, cb) {
    cb(null, persistentUploadDir);
  },
  // 决定上传的文件该叫什么名字 (时间戳 + 原本的后缀名)
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  }
});
const upload = multer({ storage: storage });

// 处理用户在后台页面上传图标的请求
router.post('/', upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({error: 'No file uploaded'});
  // 上传成功后，返回前端一个可以通过 /uploads/xxxx 访问的链接
  res.json({ filename: req.file.filename, url: '/uploads/' + req.file.filename });
});

module.exports = router;
