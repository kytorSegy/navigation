const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const persistentUploadDir = '/app/database/uploads';
if (!fs.existsSync(persistentUploadDir)) {
  fs.mkdirSync(persistentUploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, persistentUploadDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  }
});
const upload = multer({ storage: storage });

router.post('/', upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({error: 'No file uploaded'});
  res.json({ filename: req.file.filename, url: '/uploads/' + req.file.filename });
});

module.exports = router; 
