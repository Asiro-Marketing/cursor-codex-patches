const vscode = require('vscode');
const https = require('https');

class NotionTaskBoardProvider {
  constructor(context) {
    this._context = context;
    this._view = null;
    this._timer = null;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage(msg => {
      if (msg.type === 'updateStatus') this._updateTaskStatus(msg.pageId, msg.newStatus);
      if (msg.type === 'undoComplete') this._updateTaskStatus(msg.pageId, '未着手');
      if (msg.type === 'openUrl') vscode.env.openExternal(vscode.Uri.parse(msg.url));
      if (msg.type === 'refresh') this._fetchAndPost();
      if (msg.type === 'ready') this._fetchAndPost();
      if (msg.type === 'updateName') this._updateTaskName(msg.pageId, msg.newName);
      if (msg.type === 'updateDueDate') this._updateTaskDueDate(msg.pageId, msg.newDate);
      if (msg.type === 'updateDoToday') this._updateTaskDoToday(msg.pageId, msg.value);
      if (msg.type === 'updateMust') this._updateTaskMust(msg.pageId, msg.value);
      if (msg.type === 'moveTask') this._moveTask(msg.pageId, msg.targetSection);
    });

    const interval = this._getConfig().get('refreshInterval', 300) * 1000;
    this._timer = setInterval(() => {
      if (this._view && this._view.visible) this._fetchAndPost();
    }, interval);

    webviewView.onDidDispose(() => {
      clearInterval(this._timer);
      this._view = null;
    });
  }

  refresh() {
    if (this._view) this._fetchAndPost();
  }

  _getConfig() {
    return vscode.workspace.getConfiguration('notionTaskBoard');
  }

  async _fetchAndPost() {
    if (!this._view) return;
    this._view.webview.postMessage({ type: 'loading' });
    try {
      const [tasks, schema] = await Promise.all([this._fetchTasks(), this._fetchSchema()]);
      this._view.webview.postMessage({ type: 'tasks', data: tasks, schema });
    } catch (err) {
      this._view.webview.postMessage({ type: 'error', message: err.message });
    }
  }

  _fetchTasks() {
    return new Promise(async (resolve, reject) => {
      const config = this._getConfig();
      const token = config.get('token', '');
      const dbId = config.get('databaseId', '');
      const assigneeId = config.get('assigneeUserId', '');

      if (!token) return reject(new Error('Notion token が未設定です。設定 → notionTaskBoard.token を入力してください。'));

      const filterAnd = [
        { property: 'ステータス', status: { does_not_equal: '完了' } },
        { property: 'ステータス', status: { does_not_equal: '停止' } },
        { property: 'ステータス', status: { does_not_equal: 'STAY' } }
      ];
      if (assigneeId) {
        filterAnd.push({ property: '担当者', people: { contains: assigneeId } });
      }

      const fetchPage = (cursor) => new Promise((res, rej) => {
        const body = JSON.stringify({
          sorts: [
            { property: '優先度', direction: 'ascending' },
            { property: '期限', direction: 'ascending' }
          ],
          filter: { and: filterAnd },
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {})
        });

        const options = {
          hostname: 'api.notion.com',
          path: `/v1/databases/${dbId}/query`,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          }
        };

        const req = https.request(options, r => {
          let data = '';
          r.on('data', chunk => data += chunk);
          r.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.object === 'error') return rej(new Error(json.message));
              res(json);
            } catch (e) { rej(e); }
          });
        });
        req.on('error', rej);
        req.write(body);
        req.end();
      });

      try {
        const all = [];
        let cursor = null;
        let pages = 0;
        while (true) {
          const json = await fetchPage(cursor);
          all.push(...(json.results || []));
          pages++;
          if (!json.has_more || pages >= 5) break; // 最大500件で safety stop
          cursor = json.next_cursor;
        }
        resolve(this._parseResults(all));
      } catch (e) {
        reject(e);
      }
    });
  }

  _parseResults(results) {
    return results.map(page => {
      const p = page.properties;
      return {
        id: page.id,
        name: p['施策名']?.title?.[0]?.plain_text || '(無題)',
        status: p['ステータス']?.status?.name || '未着手',
        priority: p['優先度']?.select?.name || '未設定',
        kind: p['種別']?.select?.name || '',
        category: p['カテゴリ']?.select?.name || '',
        projects: (p['プロジェクト']?.multi_select || []).map(o => o.name),
        dueDate: p['期限']?.date?.start || null,
        cwUrl: p['CW_URL']?.url || null,
        notionUrl: page.url,
        doToday: p['今日やる']?.checkbox || false,
        must: p['MUST']?.checkbox || false,
        parentId: p['親アイテム']?.relation?.[0]?.id || null,
        childIds: (p['サブアイテム']?.relation || []).map(r => r.id)
      };
    });
  }

  _fetchSchema() {
    return new Promise((resolve, reject) => {
      const config = this._getConfig();
      const token = config.get('token', '');
      const dbId = config.get('databaseId', '');
      if (!token || !dbId) return resolve({ category: [], projects: [] });

      const options = {
        hostname: 'api.notion.com',
        path: `/v1/databases/${dbId}`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Notion-Version': '2022-06-28'
        }
      };
      const req = https.request(options, r => {
        let data = '';
        r.on('data', chunk => data += chunk);
        r.on('end', () => {
          try {
            const json = JSON.parse(data);
            const categoryOpts = json.properties?.['カテゴリ']?.select?.options || [];
            const projectOpts = json.properties?.['プロジェクト']?.multi_select?.options || [];
            resolve({
              category: categoryOpts.map(o => ({ name: o.name, color: o.color })),
              projects: projectOpts.map(o => ({ name: o.name, color: o.color }))
            });
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  _notionPatch(pageId, body) {
    const token = this._getConfig().get('token', '');
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: 'api.notion.com',
      path: `/v1/pages/${pageId}`,
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        setTimeout(() => this._fetchAndPost(), 500);
      });
    });
    req.on('error', err => console.error('Notion PATCH failed:', err));
    req.write(bodyStr);
    req.end();
  }

  _updateTaskStatus(pageId, newStatus) {
    this._notionPatch(pageId, {
      properties: { 'ステータス': { status: { name: newStatus } } }
    });
  }

  _updateTaskName(pageId, newName) {
    this._notionPatch(pageId, {
      properties: {
        '施策名': {
          title: [{ text: { content: newName } }]
        }
      }
    });
  }

  _updateTaskDueDate(pageId, newDate) {
    const dateValue = newDate ? { start: newDate } : null;
    this._notionPatch(pageId, {
      properties: { '期限': { date: dateValue } }
    });
  }

  _updateTaskDoToday(pageId, value) {
    this._notionPatch(pageId, {
      properties: { '今日やる': { checkbox: value } }
    });
  }

  _updateTaskMust(pageId, value) {
    // MUST=trueなら今日やるも自動ONにする
    const props = { 'MUST': { checkbox: value } };
    if (value) props['今日やる'] = { checkbox: true };
    this._notionPatch(pageId, { properties: props });
  }

  _moveTask(pageId, targetSection) {
    // Determine what properties to update based on target section
    const today = new Date();
    const props = {};

    if (targetSection === 'doToday') {
      props['今日やる'] = { checkbox: true };
    } else {
      props['今日やる'] = { checkbox: false };
      if (targetSection === 'doTomorrow') {
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        props['期限'] = { date: { start: tomorrow.toISOString().substring(0, 10) } };
      } else if (targetSection === 'thisWeek') {
        // Set to end of this week (Sunday)
        const weekEnd = new Date(today);
        weekEnd.setDate(weekEnd.getDate() + (7 - weekEnd.getDay()));
        props['期限'] = { date: { start: weekEnd.toISOString().substring(0, 10) } };
      } else if (targetSection === 'later') {
        // Clear due date
        props['期限'] = { date: null };
      }
      // 'overdue' is not a valid drop target (doesn't make sense to move to overdue)
    }

    this._notionPatch(pageId, { properties: props });
  }

  _getHtml() {
    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root {
    --space-1: 1px; --space-2: 3px; --space-3: 6px; --space-4: 10px; --space-5: 14px; --space-6: 18px;
    --radius-sm: 3px; --radius-md: 5px; --radius-lg: 8px;
    --surface-base: rgba(255,255,255,0.03);
    --border-soft: rgba(128,128,128,0.10);
    --border-mid: rgba(128,128,128,0.18);
    --priority-high: rgba(229,72,77,0.55); --priority-mid: rgba(200,160,50,0.45); --priority-low: rgba(100,130,200,0.35); --priority-none: rgba(128,128,128,0.2);
    --accent-urgent: #e05550; --accent-urgent-bg: rgba(224,85,80,0.07);
    --accent-today: #6ba0ff; --accent-today-bg: rgba(107,160,255,0.07);
    --status-todo: rgba(160,160,160,0.4); --status-progress: rgba(107,160,255,0.7); --status-done: rgba(64,190,130,0.7);
    --transition: 120ms ease;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: 12px;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    line-height: 1.5;
  }

  /* --- Header --- */
  .header {
    position: sticky; top: 0; z-index: 10;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--border-mid);
    padding: var(--space-3) var(--space-4) var(--space-2);
  }
  .header-row-1 {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: var(--space-1);
  }
  .header-title {
    font-size: 13px; font-weight: 600; letter-spacing: -0.01em;
    color: var(--vscode-foreground);
  }
  .header-right { display: flex; align-items: center; gap: var(--space-2); }
  .header-row-2 {
    display: flex; align-items: center; gap: var(--space-3);
    font-size: 10px; color: var(--vscode-descriptionForeground);
  }
  .header-stat {
    display: flex; align-items: center; gap: 3px;
  }
  .header-stat-num {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--vscode-foreground); opacity: 0.7;
  }
  .header-time {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
  }

  /* --- Search --- */
  .search-row {
    margin-top: var(--space-2);
    position: relative;
    display: none;
  }
  .search-row.open {
    display: block;
  }
  .search-input {
    width: 100%;
    padding: 4px 8px 4px 26px;
    font-size: 11px;
    font-family: inherit;
    border: 1px solid var(--border-mid);
    border-radius: var(--radius-md);
    background: var(--vscode-input-background, rgba(255,255,255,0.05));
    color: var(--vscode-input-foreground, var(--vscode-foreground));
    outline: none;
    transition: border-color var(--transition);
  }
  .search-input:focus {
    border-color: var(--vscode-focusBorder, rgba(107,160,255,0.6));
  }
  .search-input::placeholder {
    color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground));
    opacity: 0.6;
  }
  .search-icon-inline {
    position: absolute; left: 7px; top: 50%; transform: translateY(-50%);
    color: var(--vscode-descriptionForeground); opacity: 0.5;
    pointer-events: none;
  }
  .search-clear {
    position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
    width: 18px; height: 18px;
    display: none; align-items: center; justify-content: center;
    border: none; background: transparent;
    color: var(--vscode-descriptionForeground);
    cursor: pointer; border-radius: var(--radius-sm);
  }
  .search-clear:hover { background: rgba(128,128,128,0.15); }
  .search-clear.visible { display: flex; }
  .search-match { background: rgba(234,179,8,0.25); border-radius: 1px; }

  .btn-icon {
    width: 24px; height: 24px;
    display: flex; align-items: center; justify-content: center;
    border: none; border-radius: var(--radius-sm);
    background: transparent;
    color: var(--vscode-descriptionForeground);
    cursor: pointer; transition: all var(--transition);
  }
  .btn-icon:hover {
    background: rgba(128,128,128,0.15);
    color: var(--vscode-foreground);
  }
  .btn-icon svg { width: 14px; height: 14px; }

  /* --- Board --- */
  .board { padding: var(--space-3) var(--space-4) var(--space-5); }

  /* --- Loading / Error --- */
  #loading {
    display: none; text-align: center;
    padding: var(--space-6);
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }
  .spinner {
    display: inline-block; width: 16px; height: 16px;
    border: 2px solid var(--border-mid);
    border-top-color: var(--vscode-foreground);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    margin-bottom: var(--space-2);
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  #error {
    display: none;
    margin: var(--space-3) var(--space-4);
    padding: var(--space-3) var(--space-4);
    font-size: 11px;
    color: var(--accent-urgent);
    background: var(--accent-urgent-bg);
    border: 1px solid rgba(224,85,80,0.2);
    border-radius: var(--radius-md);
  }

  /* --- Section --- */
  .section { margin-bottom: var(--space-3); }
  .section-header {
    display: flex; align-items: center; gap: var(--space-2);
    padding: var(--space-3) var(--space-3);
    margin-top: var(--space-4);
    margin-bottom: var(--space-2);
    border-radius: var(--radius-md);
    cursor: pointer; user-select: none;
    transition: outline 120ms ease;
  }
  .section-cards {
    padding-left: var(--space-3);
    min-height: 2px;
    transition: background 120ms ease;
  }
  .section-header:hover .section-label { color: var(--vscode-foreground); }

  /* Section header colors */
  #sec-doToday > .section-header { background: rgba(234,179,8,0.08); }
  #sec-doTomorrow > .section-header { background: rgba(192,132,252,0.08); }
  #sec-overdue > .section-header { background: rgba(224,85,80,0.08); }
  #sec-thisWeek > .section-header { background: rgba(91,141,239,0.06); }
  #sec-later > .section-header { background: rgba(128,128,128,0.03); }

  #sec-doToday > .section-header .section-label { color: #eab308; }
  #sec-doToday > .section-header .section-count { border-color: rgba(234,179,8,0.3); color: #eab308; opacity: 1; }
  #sec-doTomorrow > .section-header .section-label { color: #c084fc; }
  #sec-doTomorrow > .section-header .section-count { border-color: rgba(192,132,252,0.3); color: #c084fc; opacity: 1; }
  #sec-overdue > .section-header .section-label { color: var(--accent-urgent); }
  #sec-overdue > .section-header .section-count { border-color: rgba(224,85,80,0.3); color: var(--accent-urgent); opacity: 1; }
  #sec-thisWeek > .section-header .section-label { color: rgba(91,141,239,0.85); }
  #sec-thisWeek > .section-header .section-count { border-color: rgba(91,141,239,0.25); color: rgba(91,141,239,0.85); opacity: 1; }

  .section-indicator {
    width: 14px; height: 14px;
    flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
  }
  .section-indicator svg {
    width: 12px; height: 12px;
  }
  .section-label {
    font-size: 12px; font-weight: 600;
    color: var(--vscode-descriptionForeground);
    transition: color var(--transition);
  }
  .section-count {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 20px; height: 16px;
    padding: 0 5px;
    font-size: 9px; font-weight: 600;
    font-variant-numeric: tabular-nums;
    border: 1px solid var(--border-soft);
    border-radius: 8px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.7;
  }
  .section-chevron {
    margin-left: auto;
    color: var(--vscode-descriptionForeground);
    opacity: 0.4;
    transition: transform var(--transition);
    transform: rotate(90deg);
  }
  .section.collapsed .section-chevron { transform: rotate(0deg); }
  .section.collapsed .section-cards { display: none; }

  /* --- Card (flat) --- */
  .card {
    position: relative;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-soft);
    transition: all var(--transition);
    cursor: default;
  }
  .card:last-child { border-bottom: none; }
  .card:hover {
    background: rgba(255,255,255,0.03);
  }
  .card.completing {
    animation: completeSlide 0.4s ease forwards;
  }
  @keyframes completeSlide {
    0% { opacity: 1; transform: translateX(0); max-height: 80px; }
    50% { opacity: 0.3; transform: translateX(30px); }
    100% { opacity: 0; transform: translateX(60px); max-height: 0; padding-top: 0; padding-bottom: 0; margin: 0; border: none; overflow: hidden; }
  }

  /* --- Drag & Drop --- */
  .card[draggable="true"] {
    cursor: grab;
  }
  .card[draggable="true"]:active {
    cursor: grabbing;
  }
  .card.dragging {
    opacity: 0.3;
  }
  .section-cards.drag-over {
    background: rgba(107,160,255,0.06);
    outline: 1px dashed rgba(107,160,255,0.3);
    outline-offset: -1px;
    border-radius: var(--radius-md);
  }
  .drop-indicator {
    height: 2px;
    background: rgba(107,160,255,0.6);
    border-radius: 1px;
    margin: 0 var(--space-3);
    transition: opacity 80ms;
  }

  /* --- MUST (今日絶対やる) --- */
  .card.must {
    background: linear-gradient(90deg, rgba(239,68,68,0.12) 0%, rgba(239,68,68,0.04) 100%);
    border-left: 3px solid #ef4444;
    padding-left: calc(var(--space-4) - 3px);
  }
  .card.must:hover {
    background: linear-gradient(90deg, rgba(239,68,68,0.18) 0%, rgba(239,68,68,0.06) 100%);
  }
  .card.must .card-name {
    color: #ef4444;
    font-weight: 600;
  }
  .must-badge {
    display: inline-flex;
    align-items: center;
    margin-right: 4px;
    color: #ef4444;
    font-size: 11px;
  }
  .must-btn.active svg { fill: #ef4444 !important; stroke: #ef4444 !important; }
  .must-btn:hover svg { fill: #ef4444; stroke: #ef4444; }

  /* --- Focus --- */
  .card.focused {
    background: rgba(234,179,8,0.06);
    border-bottom-color: rgba(234,179,8,0.15);
  }
  .card.focused .card-name {
    color: #eab308;
  }
  .card.focused .focus-indicator {
    display: inline-flex;
  }
  .card.focused .card-checkbox {
    display: none;
  }
  .focus-indicator {
    display: none;
    width: 14px; height: 14px;
    flex-shrink: 0;
    margin-top: 1px;
    color: #eab308;
  }
  .focus-indicator svg {
    width: 14px; height: 14px;
    filter: drop-shadow(0 0 3px rgba(234,179,8,0.4));
  }

  .card-row-1 {
    display: flex; align-items: center; gap: var(--space-3);
    margin-bottom: var(--space-1);
  }
  .card-checkbox {
    width: 9px; height: 9px;
    border-radius: 2px; border: 1.5px solid;
    flex-shrink: 0; margin-top: 1px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    transition: all var(--transition);
  }
  .card-checkbox:hover { border-color: var(--vscode-foreground); opacity: 0.8; }
  .card-checkbox.s-todo { border-color: rgba(160,160,160,0.4); background: transparent; }
  .card-checkbox.s-progress { border-color: rgba(107,160,255,0.6); background: rgba(107,160,255,0.1); }
  .card-checkbox.s-progress::after {
    content: ''; width: 4px; height: 4px; border-radius: 1px;
    background: rgba(107,160,255,0.7);
  }
  .card-checkbox.s-done { border-color: rgba(64,190,130,0.6); background: rgba(64,190,130,0.15); }
  .card-checkbox.s-done::after {
    content: ''; width: 5px; height: 3px;
    border-left: 1.5px solid rgba(64,190,130,0.9);
    border-bottom: 1.5px solid rgba(64,190,130,0.9);
    transform: rotate(-45deg); margin-top: -1px;
  }
  .card-status-dot.s-other { border-color: var(--priority-mid); background: transparent; }
  .card-name {
    font-size: 11px; font-weight: 450; line-height: 1.4;
    color: var(--vscode-foreground);
    flex: 1;
    cursor: text;
    min-width: 0;
  }
  .card-name-input {
    font-size: 11px; font-weight: 450; line-height: 1.4;
    font-family: inherit;
    color: var(--vscode-foreground);
    background: var(--vscode-input-background, rgba(255,255,255,0.08));
    border: 1px solid var(--vscode-focusBorder, rgba(107,160,255,0.6));
    border-radius: var(--radius-sm);
    padding: 1px 4px;
    flex: 1;
    min-width: 0;
    outline: none;
  }

  .card-row-2 {
    display: flex; align-items: center; gap: var(--space-2);
    padding-left: 13px;
    flex-wrap: wrap;
  }
  .tag {
    font-size: 10px; line-height: 16px;
    padding: 0 5px;
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }
  .tag-kind {
    color: var(--vscode-descriptionForeground);
    background: rgba(128,128,128,0.1);
  }
  /* --- Priority dots (5-step, glass) --- */
  .priority-dots {
    display: inline-flex; align-items: center; gap: 3px;
    flex-shrink: 0;
    margin-left: auto;
    padding: 0 4px;
  }
  .priority-dots .dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: transparent;
    border: 1px solid rgba(255,255,255,0.35);
    transition: all var(--transition);
  }
  .priority-dots .dot.active {
    background: rgba(255,255,255,0.75);
    border-color: rgba(255,255,255,0.85);
    box-shadow: 0 0 6px rgba(255,255,255,0.18);
  }

  /* --- Tags (glass, monochrome) --- */
  .tag-cat {
    color: rgba(255,255,255,0.82);
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.08);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    font-weight: 500;
    letter-spacing: 0.02em;
  }
  .tag-proj {
    color: rgba(255,255,255,0.55);
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.07);
    font-size: 9.5px;
  }
  .tag-proj-more {
    color: rgba(255,255,255,0.45);
    background: transparent;
    font-size: 9.5px;
  }
  .tag-due {
    color: var(--vscode-descriptionForeground);
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition: all var(--transition);
  }
  .tag-due:hover {
    background: rgba(128,128,128,0.12);
  }
  .tag-due.overdue {
    color: var(--accent-urgent);
    background: var(--accent-urgent-bg);
    font-weight: 500;
  }
  .tag-due.today {
    color: var(--accent-today);
    background: var(--accent-today-bg);
    font-weight: 500;
  }
  .tag-due-add {
    color: var(--vscode-descriptionForeground);
    opacity: 0;
    font-size: 10px;
    cursor: pointer;
    transition: opacity var(--transition);
  }
  .card:hover .tag-due-add { opacity: 0.5; }
  .tag-due-add:hover { opacity: 1 !important; }
  .due-date-input {
    font-size: 10px;
    font-family: inherit;
    padding: 0 4px;
    height: 18px;
    border: 1px solid var(--vscode-focusBorder, rgba(107,160,255,0.6));
    border-radius: var(--radius-sm);
    background: var(--vscode-input-background, rgba(255,255,255,0.08));
    color: var(--vscode-foreground);
    outline: none;
  }
  .card-links, .card-actions {
    display: flex; gap: 2px;
    opacity: 0;
    transition: opacity var(--transition);
  }
  .card-links { margin-left: auto; }
  .card:hover .card-links,
  .card:hover .card-actions { opacity: 1; }
  .card-action {
    width: 22px; height: 22px;
    display: inline-flex; align-items: center; justify-content: center;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--vscode-descriptionForeground);
    cursor: pointer; transition: all var(--transition);
    opacity: 0.5;
  }
  .card-action svg { flex-shrink: 0; }
  .card-action:hover {
    opacity: 1;
    background: rgba(128,128,128,0.1);
  }
  .card-action.focus-btn { color: var(--vscode-descriptionForeground); }
  .card-action.focus-btn:hover {
    color: #eab308;
    background: rgba(234,179,8,0.1);
  }
  .card.focused .card-action.focus-btn {
    color: #eab308;
    opacity: 1;
    background: rgba(234,179,8,0.1);
  }
  .card-action.done-btn:hover {
    color: rgba(48,164,108,0.9);
    background: rgba(48,164,108,0.1);
  }
  .card-action.cw-btn:hover {
    background: rgba(240,55,72,0.08);
  }
  .card-action.notion-btn:hover {
    color: var(--vscode-foreground);
  }

  /* --- Parent card (has children) --- */
  .card.parent-card .card-name {
    font-weight: 600;
  }
  .parent-toggle {
    width: 12px; height: 12px;
    flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    color: var(--vscode-descriptionForeground);
    opacity: 0.6;
    transition: all var(--transition);
    margin-left: -1px;
  }
  .parent-toggle:hover { opacity: 1; }
  .parent-toggle svg { width: 10px; height: 10px; transition: transform var(--transition); transform: rotate(90deg); }
  .parent-toggle.collapsed svg { transform: rotate(0deg); }
  .child-count {
    font-size: 9px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.6;
    margin-left: 2px;
  }
  .child-progress {
    font-size: 9px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.7;
    margin-left: 4px;
  }

  /* --- Child cards --- */
  .children-container {
    padding-left: 12px;
    border-left: 1px solid var(--border-soft);
    margin-left: 10px;
    margin-bottom: var(--space-2);
  }
  .children-container.hidden { display: none; }
  .children-container .card {
    padding: var(--space-2) var(--space-3);
  }
  .children-container .card-name {
    font-size: 11px;
    opacity: 0.9;
  }
  .children-container .card-row-2 {
    padding-left: 13px;
  }
  /* Nested children (grandchildren) */
  .children-container .children-container {
    margin-left: 8px;
    padding-left: 10px;
  }
  .children-container .children-container .card-name {
    font-size: 10px;
  }

  /* --- Status select --- */
  .status-select {
    font-size: 10px; font-family: inherit;
    padding: 0 4px; height: 18px;
    border: 1px solid var(--border-mid);
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border-radius: var(--radius-sm);
    cursor: pointer; outline: none;
  }

  /* --- Empty / No results --- */
  .empty, .no-results {
    text-align: center;
    padding: var(--space-6) var(--space-4);
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }
  .empty-icon { font-size: 20px; margin-bottom: var(--space-2); opacity: 0.3; }
</style>
</head>
<body>
  <div class="header">
    <div class="header-row-1">
      <span class="header-title">Tasks</span>
      <div class="header-right">
        <button class="btn-icon" id="undoBtn" onclick="undoLast()" title="直前の完了を戻す" style="display:none">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 8a5.5 5.5 0 011.3-3.5M2.5 2.5v2h2"/><path d="M2.5 8a5.5 5.5 0 105.5 5.5"/></svg>
        </button>
        <button class="btn-icon" id="searchToggle" onclick="toggleSearch()" title="検索">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
        </button>
        <button class="btn-icon" onclick="doRefresh()" title="更新">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13.5 8a5.5 5.5 0 11-1.3-3.5M13.5 2.5v2h-2"/></svg>
        </button>
      </div>
    </div>
    <div class="header-row-2">
      <span class="header-stat"><span class="header-stat-num" id="taskCount">-</span> 件</span>
      <span class="header-stat"><span class="header-stat-num" id="todayCount">-</span> 今日</span>
      <span class="header-stat"><span class="header-stat-num" id="overdueCount">-</span> 超過</span>
      <span class="header-time" id="updated"></span>
    </div>
    <div class="search-row">
      <svg class="search-icon-inline" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>
      </svg>
      <input type="text" class="search-input" id="searchInput" placeholder="タスクを検索..." autocomplete="off" spellcheck="false">
      <button class="search-clear" id="searchClear" onclick="clearSearch()">
        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 6.6L3.4 2 2 3.4 6.6 8 2 12.6 3.4 14 8 9.4 12.6 14 14 12.6 9.4 8 14 3.4 12.6 2z"/></svg>
      </button>
    </div>
  </div>
  <div id="loading"><div class="spinner"></div><div>読み込み中...</div></div>
  <div id="error"></div>
  <div class="board" id="board"></div>

<script>
  const vscode = acquireVsCodeApi();
  let allTasks = [];
  let searchQuery = '';

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'tasks') {
      allTasks = msg.data;
      renderTasks(allTasks);
      document.getElementById('loading').style.display = 'none';
      document.getElementById('error').style.display = 'none';
      document.getElementById('updated').textContent = new Date().toLocaleTimeString('ja-JP', {hour:'2-digit',minute:'2-digit'});
    }
    if (msg.type === 'loading') {
      document.getElementById('loading').style.display = 'block';
    }
    if (msg.type === 'error') {
      document.getElementById('loading').style.display = 'none';
      const el = document.getElementById('error');
      el.style.display = 'block';
      el.textContent = msg.message;
    }
  });

  window.addEventListener('DOMContentLoaded', () => {
    vscode.postMessage({ type: 'ready' });
  });

  // --- Search ---
  const searchInput = document.getElementById('searchInput');
  const searchClear = document.getElementById('searchClear');
  const searchRow = document.querySelector('.search-row');

  function toggleSearch() {
    const isOpen = searchRow.classList.toggle('open');
    if (isOpen) {
      searchInput.focus();
    } else {
      clearSearch();
    }
  }

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim().toLowerCase();
    searchClear.classList.toggle('visible', searchQuery.length > 0);
    renderTasks(allTasks);
  });

  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (searchQuery) {
        clearSearch();
      } else {
        searchRow.classList.remove('open');
      }
    }
  });

  function clearSearch() {
    searchInput.value = '';
    searchQuery = '';
    searchClear.classList.remove('visible');
    renderTasks(allTasks);
  }

  function matchesSearch(task) {
    if (!searchQuery) return true;
    const terms = searchQuery.split(/\\s+/);
    const name = task.name.toLowerCase();
    return terms.every(t => name.includes(t));
  }

  function filterTree(nodes) {
    return nodes.reduce((acc, node) => {
      if (node.children && node.children.length > 0) {
        const filteredChildren = filterTree(node.children);
        if (filteredChildren.length > 0 || matchesSearch(node)) {
          acc.push({ ...node, children: filteredChildren });
          return acc;
        }
      }
      if (matchesSearch(node)) {
        acc.push({ ...node, children: [] });
      }
      return acc;
    }, []);
  }

  function highlightName(name) {
    if (!searchQuery) return esc(name);
    const escaped = esc(name);
    const terms = searchQuery.split(/\\s+/).filter(Boolean);
    let result = escaped;
    for (const term of terms) {
      const regex = new RegExp('(' + term.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\\\$&') + ')', 'gi');
      result = result.replace(regex, '<span class="search-match">$1</span>');
    }
    return result;
  }

  const today = new Date().toISOString().substring(0, 10);
  const collapsedParents = new Set();

  function buildTree(tasks) {
    const byId = {};
    tasks.forEach(t => { byId[t.id] = { ...t, children: [] }; });
    const roots = [];
    tasks.forEach(t => {
      const node = byId[t.id];
      if (t.parentId && byId[t.parentId]) {
        byId[t.parentId].children.push(node);
      } else {
        roots.push(node);
      }
    });
    return roots;
  }

  function getBucket(task) {
    const now = new Date();
    const todayStr = today;
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().substring(0, 10);
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() + (7 - weekEnd.getDay()));
    const weekEndStr = weekEnd.toISOString().substring(0, 10);

    const d = task.dueDate ? task.dueDate.substring(0, 10) : null;
    let effectiveDate = d;
    if (!effectiveDate && task.children && task.children.length > 0) {
      const childDates = task.children.map(c => c.dueDate).filter(Boolean).map(dd => dd.substring(0, 10));
      if (childDates.length > 0) effectiveDate = childDates.sort()[0];
    }

    // 期限優先で判定（今日やる=ONでも期限超過は超過セクションへ）
    if (effectiveDate && effectiveDate < todayStr) return 'overdue';
    if (effectiveDate && effectiveDate === todayStr) return 'doToday';
    if (effectiveDate && effectiveDate === tomorrowStr) return 'doTomorrow';
    // 期限なし or 今週以降で今日やる=ONなら今日セクション
    if (task.doToday) return 'doToday';
    if (task.children && task.children.some(c => c.doToday)) return 'doToday';
    if (effectiveDate && effectiveDate <= weekEndStr) return 'thisWeek';
    return 'later';
  }

  function renderTasks(tasks) {
    let tree = buildTree(tasks);
    if (searchQuery) {
      tree = filterTree(tree);
    }

    const buckets = { doToday: [], doTomorrow: [], overdue: [], thisWeek: [], later: [] };
    tree.forEach(node => { buckets[getBucket(node)].push(node); });

    // 今日やる内でMUSTを先頭に並べ替え
    buckets.doToday.sort((a, b) => {
      const am = a.must || (a.children && a.children.some(c => c.must));
      const bm = b.must || (b.children && b.children.some(c => c.must));
      if (am === bm) return 0;
      return am ? -1 : 1;
    });

    // 超過セクション内で今日やる=ONを先頭に並べ替え（今日着手するものを上に）
    buckets.overdue.sort((a, b) => {
      const ad = a.doToday || (a.children && a.children.some(c => c.doToday));
      const bd = b.doToday || (b.children && b.children.some(c => c.doToday));
      if (ad === bd) return 0;
      return ad ? -1 : 1;
    });

    let totalLeaf = 0, todayLeaf = 0, overdueLeaf = 0;
    for (const [key, items] of Object.entries(buckets)) {
      const c = items.reduce((sum, n) => sum + (n.children.length > 0 ? n.children.length : 1), 0);
      totalLeaf += c;
      if (key === 'doToday') todayLeaf = c;
      if (key === 'overdue') overdueLeaf = c;
    }

    document.getElementById('taskCount').textContent = totalLeaf;
    document.getElementById('todayCount').textContent = todayLeaf;
    document.getElementById('overdueCount').textContent = overdueLeaf;

    const icons = {
      doToday: '<svg viewBox="0 0 16 16" fill="#eab308" stroke="none"><path d="M8 1l2.1 4.3 4.7.7-3.4 3.3.8 4.7L8 11.8 3.8 14l.8-4.7L1.2 6l4.7-.7z"/></svg>',
      doTomorrow: '<svg viewBox="0 0 16 16" fill="none" stroke="#c084fc" stroke-width="1.5"><path d="M8 2v3M8 11v3M2 8h3M11 8h3M4.2 4.2l2.1 2.1M9.7 9.7l2.1 2.1M11.8 4.2l-2.1 2.1M6.3 9.7l-2.1 2.1"/></svg>',
      overdue: '<svg viewBox="0 0 16 16" fill="#e05550" stroke="none"><path d="M8 1C6.5 3.5 4 6 4 9a4 4 0 008 0c0-3-2.5-5.5-4-8zM7 12c-1.1 0-2-.7-2-2 0-1 .8-2 2-3.5 1.2 1.5 2 2.5 2 3.5 0 1.3-.9 2-2 2z"/></svg>',
      thisWeek: '<svg viewBox="0 0 16 16" fill="none" stroke="rgba(107,160,255,0.7)" stroke-width="1.5"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.5l2.5 1.5"/></svg>',
      later: '<svg viewBox="0 0 16 16" fill="none" stroke="rgba(128,128,128,0.35)" stroke-width="1.5"><circle cx="8" cy="8" r="3"/></svg>',
    };

    const sections = [
      { key: 'doToday', label: '今日やる', items: buckets.doToday, icon: icons.doToday },
      { key: 'doTomorrow', label: '明日やる', items: buckets.doTomorrow, icon: icons.doTomorrow },
      { key: 'overdue', label: '期限超過', items: buckets.overdue, icon: icons.overdue },
      { key: 'thisWeek', label: '今週中にやる', items: buckets.thisWeek, icon: icons.thisWeek },
      { key: 'later', label: 'その他', items: buckets.later, icon: icons.later },
    ];

    let html = '';
    for (const sec of sections) {
      const itemCount = (sec.items || []).reduce((sum, n) => sum + (n.children.length > 0 ? n.children.length : 1), 0);
      // Always render section for drop targets, hide if empty and not searching
      const isEmpty = !sec.items || sec.items.length === 0;
      html += '<div class="section' + (isEmpty ? ' collapsed' : '') + '" id="sec-' + sec.key + '" data-section="' + sec.key + '"' + (isEmpty ? ' style="display:none"' : '') + '>'
        + '<div class="section-header" onclick="toggleSection(this)">'
        + '<span class="section-indicator">' + sec.icon + '</span>'
        + '<span class="section-label">' + sec.label + '</span>'
        + '<span class="section-count">' + itemCount + '</span>'
        + '<svg class="section-chevron" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M5.7 13.7L4.3 12.3 8.6 8 4.3 3.7 5.7 2.3 11.4 8z"/></svg>'
        + '</div>'
        + '<div class="section-cards" data-drop-section="' + sec.key + '">';
      for (const node of (sec.items || [])) {
        html += renderNode(node);
      }
      html += '</div></div>';
    }

    if (searchQuery && totalLeaf === 0) {
      html = '<div class="no-results">検索結果なし</div>';
    } else if (!searchQuery && totalLeaf === 0) {
      html = '<div class="empty"><div class="empty-icon">\\u2713</div>タスクなし</div>';
    }

    document.getElementById('board').innerHTML = html;

    // Restore focus state
    if (focusedId) {
      const el = document.querySelector('[data-task-id="' + focusedId + '"]');
      if (el) el.classList.add('focused');
    }

    // Setup drag & drop after render
    setupDragAndDrop();
  }

  function renderNode(node) {
    const hasChildren = node.children && node.children.length > 0;
    const pCls = ({'高':'p-high','中':'p-mid','低':'p-low'})[node.priority] || 'p-none';
    const mustCls = node.must ? ' must' : '';
    const mustBadge = node.must ? '<span class="must-badge" title="今日絶対やる">\\ud83d\\udd25</span>' : '';

    if (hasChildren) {
      const isCollapsed = collapsedParents.has(node.id);
      const completedChildren = node.children.filter(c => c.status === '完了').length;
      const totalChildren = node.children.length;
      const progressText = completedChildren + '/' + totalChildren;

      let html = '<div class="card parent-card ' + pCls + mustCls + '" data-task-id="' + node.id + '" draggable="true">'
        + '<div class="card-row-1">'
        + '<span class="parent-toggle' + (isCollapsed ? ' collapsed' : '') + '" onclick="event.stopPropagation();toggleParent(\\'' + node.id + '\\')">'
        + '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5.7 13.7L4.3 12.3 8.6 8 4.3 3.7 5.7 2.3 11.4 8z"/></svg>'
        + '</span>'
        + '<span class="focus-indicator"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg></span>'
        + mustBadge
        + '<span class="card-name" ondblclick="event.stopPropagation();startEditName(\\'' + node.id + '\\', this)">' + highlightName(node.name) + '</span>'
        + '<span class="child-progress">' + progressText + '</span>'
        + '</div>'
        + '<div class="card-row-2">';
      html += dueTag(node);
      html += kindTag(node);
      html += priorityDots(node);
      html += actionsHtml(node);
      html += '</div></div>';

      html += '<div class="children-container' + (isCollapsed ? ' hidden' : '') + '" data-parent="' + node.id + '">';
      for (const child of node.children) {
        html += renderNode(child);
      }
      html += '</div>';
      return html;
    } else {
      return cardHtml(node, pCls);
    }
  }

  function statusClass(status) {
    if (status === '未着手') return 's-todo';
    if (status === '進行中') return 's-progress';
    if (status === '完了') return 's-done';
    return 's-todo';
  }

  function dueTag(task) {
    if (!task.dueDate) {
      return '<span class="tag-due-add" onclick="event.stopPropagation();startEditDueDate(\\'' + task.id + '\\', null, this)" title="期日を設定">+ 期日</span>';
    }
    const d = task.dueDate.substring(0, 10);
    const isOverdue = d < today;
    const isToday = d === today;
    const label = d.substring(5).replace('-', '/');
    const dueClass = isOverdue ? ' overdue' : isToday ? ' today' : '';
    return '<span class="tag tag-due' + dueClass + '" onclick="event.stopPropagation();startEditDueDate(\\'' + task.id + '\\', \\'' + d + '\\', this)" title="クリックで期日変更">' + label + (isOverdue ? ' !' : '') + '</span>';
  }

  function priorityDots(task) {
    let level = 0;
    if (task.must) level = 5;
    else if (task.priority === '高') level = 4;
    else if (task.priority === '中') level = 3;
    else if (task.priority === '低') level = 1;
    if (level === 0) return '';
    const title = task.must ? 'MUST（5/5）' : '優先度: ' + task.priority + ' (' + level + '/5)';
    let html = '<span class="priority-dots lv-' + level + '" title="' + title + '">';
    for (let i = 1; i <= 5; i++) {
      html += '<span class="dot' + (i <= level ? ' active' : '') + '"></span>';
    }
    html += '</span>';
    return html;
  }

  function kindTag(task) {
    let html = '';
    if (task.category) {
      html += '<span class="tag tag-cat" title="カテゴリ: ' + esc(task.category) + '">' + esc(task.category) + '</span>';
    }
    if (task.projects && task.projects.length > 0) {
      for (const proj of task.projects.slice(0, 2)) {
        html += '<span class="tag tag-proj" title="プロジェクト: ' + esc(proj) + '">' + esc(proj) + '</span>';
      }
      if (task.projects.length > 2) {
        html += '<span class="tag tag-proj-more" title="' + esc(task.projects.slice(2).join(', ')) + '">+' + (task.projects.length - 2) + '</span>';
      }
    }
    return html;
  }

  function actionsHtml(task) {
    let links = '<span class="card-links">';
    if (task.cwUrl) links += '<button class="card-action cw-btn" onclick="event.stopPropagation();openUrl(\\'' + task.cwUrl + '\\')" title="Chatworkで開く"><svg viewBox="0 0 64 64" width="12" height="12"><path fill="#34362F" d="M50.4,3.8c-5.1-5.1-13.3-5.1-18.3,0c-2.3,2.3-3.7,5.4-3.8,8.7v12.3c0,0.6,0.5,1.2,1.2,1.2h11.2c3.6.2,7.2-1.2,9.7-3.8C55.5,17.1,55.5,8.9,50.4,3.8z"/><path fill="#F03748" d="M3.8,13.7C-1.3,18.8-1.3,27,3.8,32c2.3,2.3,5.4,3.7,8.7,3.8h12.3c.6,0,1.1-.5,1.1-1.1V23.4c.2-3.6-1.2-7.2-3.8-9.7C17,8.7,8.9,8.7,3.8,13.7zM13.7,60.2c5.1,5,13.3,5,18.3-.1c2.3-2.3,3.6-5.4,3.7-8.6V39.3c0-.6-.5-1.1-1.1-1.1H23.4c-3.6-.2-7.2,1.2-9.7,3.8C8.7,47,8.7,55.1,13.7,60.2zM60.2,50.3c5.1-5,5.1-13.2,0-18.3c-2.3-2.3-5.4-3.7-8.7-3.8H39.3c-.6,0-1.2,.5-1.2,1.1v11.2c-.2,3.6,1.2,7.2,3.8,9.7C47,55.4,55.1,55.4,60.2,50.3z"/></svg></button>';
    links += '<button class="card-action notion-btn" onclick="event.stopPropagation();openUrl(\\'' + task.notionUrl + '\\')" title="Notionで開く"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z"/></svg></button>';
    links += '</span>';
    let actions = '<span class="card-actions">';
    actions += '<button class="card-action must-btn' + (task.must ? ' active' : '') + '" onclick="event.stopPropagation();toggleMust(\\'' + task.id + '\\', ' + (!task.must) + ')" title="' + (task.must ? 'MUST解除' : '今日絶対やる（MUST）') + '"><svg viewBox="0 0 24 24" width="13" height="13" fill="' + (task.must ? '#ef4444' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2s3 3 3 7-3 4-3 4-3-2-3-4c0-2 1-3 3-7z M8 13c0 3 1.5 6 4 9 2.5-3 4-6 4-9-1 1-2 1.5-4 1.5S9 14 8 13z"/></svg></button>';
    actions += '<button class="card-action focus-btn" onclick="event.stopPropagation();toggleFocus(\\'' + task.id + '\\', this.closest(\\'.card\\'))" title="集中"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg></button>';
    actions += '<button class="card-action done-btn" onclick="event.stopPropagation();markDone(\\'' + task.id + '\\', this.closest(\\'.card\\'))" title="完了"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></button>';
    actions += '</span>';
    return links + actions;
  }

  function cardHtml(task, cls) {
    const mustCls = task.must ? ' must' : '';
    const mustBadge = task.must ? '<span class="must-badge" title="今日絶対やる">\\ud83d\\udd25</span>' : '';
    return '<div class="card ' + cls + mustCls + '" data-task-id="' + task.id + '" draggable="true">'
      + '<div class="card-row-1">'
      + '<span class="focus-indicator"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg></span>'
      + '<span class="card-checkbox ' + statusClass(task.status) + '" title="' + task.status + '" onclick="event.stopPropagation();markDone(\\'' + task.id + '\\', this.closest(\\'.card\\'))"></span>'
      + mustBadge
      + '<span class="card-name" ondblclick="event.stopPropagation();startEditName(\\'' + task.id + '\\', this)">' + highlightName(task.name) + '</span>'
      + '</div>'
      + '<div class="card-row-2">'
      + dueTag(task) + kindTag(task) + priorityDots(task) + actionsHtml(task)
      + '</div>'
      + '</div>';
  }

  function esc(s) {
    const el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }

  let focusedId = null;
  let lastCompletedId = null;

  function toggleParent(parentId) {
    if (collapsedParents.has(parentId)) {
      collapsedParents.delete(parentId);
    } else {
      collapsedParents.add(parentId);
    }
    const container = document.querySelector('[data-parent="' + parentId + '"]');
    const toggle = document.querySelector('[data-task-id="' + parentId + '"] .parent-toggle');
    if (container) container.classList.toggle('hidden');
    if (toggle) toggle.classList.toggle('collapsed');
  }

  function toggleFocus(pageId, el) {
    document.querySelectorAll('.card.focused').forEach(c => c.classList.remove('focused'));
    if (focusedId === pageId) {
      focusedId = null;
      return;
    }
    focusedId = pageId;
    if (el) el.classList.add('focused');
  }

  function markDone(pageId, el) {
    if (focusedId === pageId && el && el.classList.contains('focused')) {
      return;
    }
    if (el) el.classList.add('completing');
    lastCompletedId = pageId;
    document.getElementById('undoBtn').style.display = 'flex';
    vscode.postMessage({ type: 'updateStatus', pageId: pageId, newStatus: '完了' });
  }

  function toggleMust(pageId, newValue) {
    vscode.postMessage({ type: 'updateMust', pageId: pageId, value: newValue });
  }

  function undoLast() {
    if (!lastCompletedId) return;
    vscode.postMessage({ type: 'undoComplete', pageId: lastCompletedId });
    lastCompletedId = null;
    document.getElementById('undoBtn').style.display = 'none';
  }

  function openUrl(url) {
    vscode.postMessage({ type: 'openUrl', url: url });
  }

  function doRefresh() {
    vscode.postMessage({ type: 'refresh' });
  }

  function toggleSection(header) {
    header.parentElement.classList.toggle('collapsed');
  }

  // --- Inline Name Edit ---
  function startEditName(taskId, nameEl) {
    const currentText = nameEl.textContent || nameEl.innerText;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'card-name-input';
    input.value = currentText;

    nameEl.style.display = 'none';
    nameEl.parentNode.insertBefore(input, nameEl.nextSibling);
    input.focus();
    input.select();

    function commit() {
      const newName = input.value.trim();
      if (newName && newName !== currentText) {
        vscode.postMessage({ type: 'updateName', pageId: taskId, newName: newName });
        nameEl.textContent = newName;
      }
      input.remove();
      nameEl.style.display = '';
    }

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = currentText; input.blur(); }
    });
  }

  // --- Inline Due Date Edit ---
  function startEditDueDate(taskId, currentDate, el) {
    // Replace tag with date input
    const input = document.createElement('input');
    input.type = 'date';
    input.className = 'due-date-input';
    input.value = currentDate || '';

    el.style.display = 'none';
    el.parentNode.insertBefore(input, el.nextSibling);
    input.focus();

    function commit() {
      const newDate = input.value;
      if (newDate !== (currentDate || '')) {
        vscode.postMessage({ type: 'updateDueDate', pageId: taskId, newDate: newDate || null });
      }
      input.remove();
      el.style.display = '';
    }

    input.addEventListener('blur', commit);
    input.addEventListener('change', () => { input.blur(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { input.value = currentDate || ''; input.blur(); }
    });
  }

  // --- Drag & Drop ---
  let draggedTaskId = null;

  function setupDragAndDrop() {
    const cards = document.querySelectorAll('.card[draggable="true"]');
    const dropZones = document.querySelectorAll('.section-cards[data-drop-section]');

    cards.forEach(card => {
      card.addEventListener('dragstart', e => {
        draggedTaskId = card.dataset.taskId;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', draggedTaskId);
        // Show all sections as potential drop targets
        document.querySelectorAll('.section').forEach(sec => {
          sec.style.display = '';
          sec.classList.remove('collapsed');
        });
      });

      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        draggedTaskId = null;
        dropZones.forEach(z => z.classList.remove('drag-over'));
        // Re-hide empty sections
        document.querySelectorAll('.section').forEach(sec => {
          const cards = sec.querySelector('.section-cards');
          if (cards && cards.children.length === 0) {
            sec.style.display = 'none';
          }
        });
      });
    });

    dropZones.forEach(zone => {
      zone.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        zone.classList.add('drag-over');
      });

      zone.addEventListener('dragleave', e => {
        // Only remove if truly leaving the zone
        if (!zone.contains(e.relatedTarget)) {
          zone.classList.remove('drag-over');
        }
      });

      zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        const taskId = e.dataTransfer.getData('text/plain');
        const targetSection = zone.dataset.dropSection;
        if (taskId && targetSection) {
          vscode.postMessage({ type: 'moveTask', pageId: taskId, targetSection: targetSection });
        }
      });
    });
  }
</script>
</body>
</html>`;
  }
}

function activate(context) {
  const provider = new NotionTaskBoardProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('notionTaskBoard', provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('notionTaskBoard.refresh', () => {
      provider.refresh();
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
