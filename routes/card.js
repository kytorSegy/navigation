const express = require('express');
const db = require('../db');
const auth = require('./authMiddleware');
const router = express.Router();

// [新增工具函数] 用于把存进数据库的原始 url 包装成我们的代理请求格式
function buildDisplayLogo(card) {
  // 1. 如果用户自己在后台传了图标，直接返回本地路径
  if (card.custom_logo_path) {
    return '/uploads/' + card.custom_logo_path;
  }
  
  // 2. 如果没有自定义，就取用户填的 logo_url，如果也没填，就瞎猜一个该网址的 favicon.ico
  const remoteLogo = card.logo_url || (card.url.replace(/\/+$/, '') + '/favicon.ico');
  
  // 3. 只要是一个 http 链接，我们就把它丢给我们在 app.js 里写的 /api/icon 去处理缓存
  if (/^https?:\/\//i.test(remoteLogo)) {
    const fallbackSite = /^https?:\/\//i.test(card.url) ? card.url : '';
    // 组装参数，比如把 url=xxx & site=xxx 拼装起来
    const query = new URLSearchParams({
      url: remoteLogo,
      ...(fallbackSite ? { site: fallbackSite } : {})
    });
    return `/api/icon?${query.toString()}`;
  }
  
  // 兜底：如果不是 http 链接，原样返回
  return remoteLogo;
}

// ✅ [新增] 全站搜索接口 —— 必须放在 /:menuId 路由之前，否则 "search" 会被当成 menuId
router.get('/search', (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) return res.json([]);

  const keyword = `%${q.trim()}%`;
  const query = `
    SELECT * FROM cards 
    WHERE title LIKE ? OR url LIKE ? OR desc LIKE ? 
    ORDER BY "order"
  `;

  db.all(query, [keyword, keyword, keyword], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    // 循环给每一条搜索到的卡片附加上经过包装的显示图标
    rows.forEach(card => {
      card.display_logo = buildDisplayLogo(card);
    });
    res.json(rows);
  });
});

// 获取指定菜单的卡片
router.get('/:menuId', (req, res) => {
  const { subMenuId } = req.query;
  let query, params;
  
  if (subMenuId) {
    // 获取指定子菜单的卡片
    query = 'SELECT * FROM cards WHERE sub_menu_id = ? ORDER BY "order"';
    params = [subMenuId];
  } else {
    // 获取主菜单的卡片（不包含子菜单的卡片）
    query = 'SELECT * FROM cards WHERE menu_id = ? AND sub_menu_id IS NULL ORDER BY "order"';
    params = [req.params.menuId];
  }
  
  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({error: err.message});
    // 循环给当前菜单下的卡片附加上经过包装的显示图标
    rows.forEach(card => {
      card.display_logo = buildDisplayLogo(card);
    });
    res.json(rows);
  });
});

// 新增、修改、删除卡片需认证 (下面的逻辑保持不动)
router.post('/', auth, (req, res) => {
  const { menu_id, sub_menu_id, title, url, logo_url, custom_logo_path, desc, order } = req.body;
  db.run('INSERT INTO cards (menu_id, sub_menu_id, title, url, logo_url, custom_logo_path, desc, "order") VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 
    [menu_id, sub_menu_id || null, title, url, logo_url, custom_logo_path, desc, order || 0], function(err) {
    if (err) return res.status(500).json({error: err.message});
    res.json({ id: this.lastID });
  });
});

router.put('/:id', auth, (req, res) => {
  const { menu_id, sub_menu_id, title, url, logo_url, custom_logo_path, desc, order } = req.body;
  db.run('UPDATE cards SET menu_id=?, sub_menu_id=?, title=?, url=?, logo_url=?, custom_logo_path=?, desc=?, "order"=? WHERE id=?', 
    [menu_id, sub_menu_id || null, title, url, logo_url, custom_logo_path, desc, order || 0, req.params.id], function(err) {
    if (err) return res.status(500).json({error: err.message});
    res.json({ changed: this.changes });
  });
});

router.delete('/:id', auth, (req, res) => {
  db.run('DELETE FROM cards WHERE id=?', [req.params.id], function(err) {
    if (err) return res.status(500).json({error: err.message});
    res.json({ deleted: this.changes });
  });
});

module.exports = router;
