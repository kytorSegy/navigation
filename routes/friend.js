const express = require('express');
const db = require('../db');
const auth = require('./authMiddleware');
const router = express.Router();

function normalizeFriendLogo(logo, siteUrl = '') {
  if (!logo) return logo;
  if (/^https?:\/\//i.test(logo)) {
    const query = new URLSearchParams({
      url: logo,
      ...(siteUrl && /^https?:\/\//i.test(siteUrl) ? { site: siteUrl } : {})
    });
    return `/api/icon?${query.toString()}`;
  }
  return logo;
}

// 获取友链
router.get('/', (req, res) => {
  const { page, pageSize } = req.query;
  if (!page && !pageSize) {
    db.all('SELECT * FROM friends', [], (err, rows) => {
      if (err) return res.status(500).json({error: err.message});
      rows.forEach((row) => {
        row.logo = normalizeFriendLogo(row.logo, row.url);
      });
      res.json(rows);
    });
  } else {
    const pageNum = parseInt(page) || 1;
    const size = parseInt(pageSize) || 10;
    const offset = (pageNum - 1) * size;
    db.get('SELECT COUNT(*) as total FROM friends', [], (err, countRow) => {
      if (err) return res.status(500).json({error: err.message});
      db.all('SELECT * FROM friends LIMIT ? OFFSET ?', [size, offset], (err, rows) => {
        if (err) return res.status(500).json({error: err.message});
        rows.forEach((row) => {
          row.logo = normalizeFriendLogo(row.logo, row.url);
        });
        res.json({
          total: countRow.total,
          page: pageNum,
          pageSize: size,
          data: rows
        });
      });
    });
  }
});
// 新增友链
router.post('/', auth, (req, res) => {
  const { title, url, logo } = req.body;
  db.run('INSERT INTO friends (title, url, logo) VALUES (?, ?, ?)', [title, url, logo], function(err) {
    if (err) return res.status(500).json({error: err.message});
    res.json({ id: this.lastID });
  });
});
// 修改友链
router.put('/:id', auth, (req, res) => {
  const { title, url, logo } = req.body;
  db.run('UPDATE friends SET title=?, url=?, logo=? WHERE id=?', [title, url, logo, req.params.id], function(err) {
    if (err) return res.status(500).json({error: err.message});
    res.json({ changed: this.changes });
  });
});
// 删除友链
router.delete('/:id', auth, (req, res) => {
  db.run('DELETE FROM friends WHERE id=?', [req.params.id], function(err) {
    if (err) return res.status(500).json({error: err.message});
    res.json({ deleted: this.changes });
  });
});

module.exports = router; 
