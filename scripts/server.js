const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const PORT = 19000;
const DASHBOARD_PATH = '/home/root/.openclaw/workspace/skills/dashboard-service/frontend/index.html';
const STAR_OFFICE_PATH = '/workspace/Star-Office-UI';

// 静态文件缓存
const cache = new Map();

// 运行时状态
let apiCalls = 0;
let taskCount = 0;
let currentTaskInfo = '';
let activityLevel = 50;  // 活跃度 0-100
let taskQueue = [];  // 任务队列
let chatCount = 0;
const startTime = Date.now();
const statusHistory = [];

// v118.0: 增强指标收集
const metrics = {
  requestsTotal: 0,
  requestsSuccess: 0,
  requestsFailed: 0,
  evomapRetries: 0,
  lastError: null,
  lastErrorTime: null
};

// v111.0: SSE 客户端管理 (更轻量，无需额外依赖)
const sseClients = new Set();

// v118.0: EvoMap 节点状态缓存 - 增强容错和缓存策略
let evomapStatus = null;
let evomapStatusTime = 0;
let evomapFailureCount = 0;
let evomapAbortController = null;
const EVOMAP_CACHE_TIME = 60000; // 1分钟缓存
const EVOMAP_MAX_CACHE_TIME = 300000; // 失败时最多缓存5分钟
const EVOMAP_RETRY_DELAY = 5000; // 重试间隔5秒
const EVOMAP_NODE_ID = 'node_6de4354b';

// 状态历史记录
function addStatusHistory(status) {
    statusHistory.push({ status, time: Date.now() });
    if (statusHistory.length > 50) statusHistory.shift();
}

// v111.0: 广播消息到所有 SSE 客户端
function broadcastSSE(data) {
    if (sseClients.size === 0) return;
    const message = `data: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach(client => {
        client.write(message);
    });
}

function getContentType(url) {
  if (url.endsWith('.html')) return 'text/html';
  if (url.endsWith('.js')) return 'application/javascript';
  if (url.endsWith('.css')) return 'text/css';
  if (url.endsWith('.png')) return 'image/png';
  if (url.endsWith('.jpg') || url.endsWith('.jpeg')) return 'image/jpeg';
  if (url.endsWith('.webp')) return 'image/webp';
  if (url.endsWith('.woff') || url.endsWith('.woff2')) return 'font/woff2';
  return 'text/plain';
}

function serveFile(filePath, res) {
  const ext = path.extname(filePath);
  const contentType = getContentType(filePath);
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    
    res.writeHead(200, { 
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600'
    });
    res.end(data);
  });
}

function serveStarOffice(req, res) {
  const url = req.url.replace(/^\/star/, '') || '/';
  const filePath = path.join(STAR_OFFICE_PATH, 'frontend', url);
  
  if (url === '/' || !url.includes('.')) {
    serveFile(path.join(STAR_OFFICE_PATH, 'frontend', 'index.html'), res);
    return;
  }
  
  serveFile(filePath, res);
}

function serveDashboard(req, res) {
  serveFile(DASHBOARD_PATH, res);
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  const url = req.url;
  
  // v118.0: Enhanced health check with detailed status
  if (url === '/health' || url === '/api/health') {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);
    
    // CPU 使用率
    const cpus = os.cpus();
    let totalIdle = 0, totalTick = 0;
    cpus.forEach(cpu => {
      for (let type in cpu.times) totalTick += cpu.times[type];
      totalIdle += cpu.times.idle;
    });
    const cpuPercent = Math.round((1 - totalIdle / totalTick) * 100);
    
    res.writeHead(200, { 
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    });
    res.end(JSON.stringify({ 
      status: 'ok', 
      service: 'dashboard',
      version: 'v118.0',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      memory: memPercent,
      cpu: cpuPercent,
      apiCalls: apiCalls,
      evomap: {
        connected: evomapStatus !== null,
        fresh: evomapStatusTime > 0 && (Date.now() - evomapStatusTime) < EVOMAP_CACHE_TIME,
        failures: evomapFailureCount
      },
      metrics: {
        total: metrics.requestsTotal,
        success: metrics.requestsSuccess,
        failed: metrics.requestsFailed
      },
      time: new Date().toISOString()
    }));
    return;
  }
  
  // 状态 API
  if (url === '/api/status') {
    apiCalls++;
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const secs = uptime % 60;
    const uptimeStr = `${hours}h ${mins}m ${secs}s`;
    
    // 获取内存使用情况
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);
    
    // 获取CPU使用率（简单估算）
    const cpus = os.cpus();
    let totalIdle = 0, totalTick = 0;
    cpus.forEach(cpu => {
      for (let type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });
    const cpuPercent = Math.round((1 - totalIdle / totalTick) * 100);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      uptime: uptimeStr,
      memory: `${Math.round(usedMem / 1024 / 1024)}MB`,
      memoryPercent: memPercent,
      cpuPercent: cpuPercent,
      sessions: '1',
      apiCalls: apiCalls,
      taskCount: taskCount,
      chatCount: chatCount,
      gateway: true,
      status: 'idle',
      statusHistory: statusHistory.slice(-10)
    }));
    return;
  }
  
  // 计算动态缓存时间（失败时指数退避）
function getEvomapCacheTime() {
  if (evomapFailureCount === 0) return EVOMAP_CACHE_TIME;
  return Math.min(EVOMAP_CACHE_TIME * Math.pow(2, evomapFailureCount), EVOMAP_MAX_CACHE_TIME);
}

// v118.0: Promise化请求，支持超时和中止
function evomapRequest(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    // 取消之前的请求
    if (evomapAbortController) {
      evomapAbortController.abort();
    }
    evomapAbortController = new AbortController();
    
    const req = https.get(url, { 
      timeout, 
      signal: evomapAbortController.signal 
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`JSON解析失败: ${e.message}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    
    req.on('error', (err) => {
      if (err.name === 'AbortError') {
        reject(new Error('请求被取消'));
      } else {
        reject(err);
      }
    });
    
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
  });
}

// v118.0: 智能重试机制
async function fetchEvomapStatusWithRetry(maxRetries = 3) {
  const cacheTime = getEvomapCacheTime();
  
  // 如果缓存新鲜，直接返回
  if (evomapStatus && (Date.now() - evomapStatusTime) < cacheTime) {
    return { data: evomapStatus, fromCache: true, age: Date.now() - evomapStatusTime };
  }
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const data = await evomapRequest(`https://evomap.ai/a2a/nodes/${EVOMAP_NODE_ID}`);
      evomapStatus = data;
      evomapStatusTime = Date.now();
      evomapFailureCount = 0;
      metrics.evomapRetries = attempt;
      metrics.lastError = null;
      console.log(`[EvoMap] 获取成功 (尝试 ${attempt + 1})`);
      return { data, fromCache: false, age: 0 };
    } catch (err) {
      console.warn(`[EvoMap] 尝试 ${attempt + 1}/${maxRetries} 失败: ${err.message}`);
      metrics.evomapRetries = attempt + 1;
      metrics.lastError = err.message;
      metrics.lastErrorTime = new Date().toISOString();
      
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, EVOMAP_RETRY_DELAY * (attempt + 1)));
      }
    }
  }
  
  // 所有重试都失败
  evomapFailureCount++;
  console.warn(`[EvoMap] 所有重试失败, 失败计数: ${evomapFailureCount}, 使用缓存`);
  return { data: evomapStatus, fromCache: true, age: Date.now() - evomapStatusTime, failed: true };
}

// 保持向后兼容
async function fetchEvomapStatus() {
  const result = await fetchEvomapStatusWithRetry();
  return result.data;
}

// Dashboard API (simplified for frontend) - v118.0: 增强EvoMap状态信息
  if (url === '/api/dashboard') {
    apiCalls++;
    metrics.requestsTotal++;
    
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const uptimeStr = hours > 0 ? `${hours}h` : '<1h';
    
    const now = new Date();
    const heartbeat = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    
    // v118.0: 使用增强的EvoMap获取（带重试）
    const evomapResult = await fetchEvomapStatusWithRetry();
    const evomap = evomapResult.data;
    
    // 判断EvoMap数据是否新鲜
    const evomapAge = evomapStatusTime > 0 ? Date.now() - evomapStatusTime : null;
    const evomapFresh = evomapAge !== null && evomapAge < EVOMAP_CACHE_TIME;
    
    // v118.0: 记录成功/失败
    if (evomapResult.failed) {
      metrics.requestsFailed++;
    } else {
      metrics.requestsSuccess++;
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      heartbeat: heartbeat,
      msgCount: chatCount,
      taskDone: taskCount,
      uptime: uptimeStr,
      currentTask: currentTaskInfo,
      taskQueue: taskQueue,
      activityLevel: activityLevel,
      evomap: evomap ? {
        reputation: evomap.reputation_score,
        published: evomap.total_published,
        promoted: evomap.total_promoted,
        online: evomap.online,
        survival: evomap.survival_status,
        tasksCompleted: evomap.total_tasks_completed,
        reputationRank: evomap.reputation_rank
      } : null,
      evomapStatus: {
        available: evomap !== null,
        fresh: evomapFresh,
        fromCache: evomapResult.fromCache,
        age: evomapAge,
        failureCount: evomapFailureCount,
        retries: metrics.evomapRetries,
        lastSuccess: evomapStatusTime > 0 ? new Date(evomapStatusTime).toISOString() : null,
        lastError: metrics.lastError
      },
      metrics: {
        uptime: uptime,
        requestsTotal: metrics.requestsTotal,
        requestsSuccess: metrics.requestsSuccess,
        requestsFailed: metrics.requestsFailed
      }
    }));
    return;
  }
  
  // Heartbeat API - v88.0: Added for frontend compatibility
  if (url === '/api/heartbeat') {
    apiCalls++;
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const uptimeStr = hours > 0 ? `${hours}h` : '<1h';
    
    const now = new Date();
    const heartbeat = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    
    // Determine status based on activity level
    let status = 'idle';
    if (activityLevel > 80) status = 'excited';
    else if (activityLevel > 60) status = 'working';
    else if (activityLevel < 20) status = 'sleeping';
    
    // Calculate task progress (0-100)
    const taskProgress = taskQueue.length > 0 ? Math.round((1 - taskQueue.length / 10) * 100) : 0;
    
    // 同步获取 EvoMap 状态
    const evomap = await fetchEvomapStatus();
    
    res.writeHead(200, { 
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    });
    res.end(JSON.stringify({
      heartbeat: heartbeat,
      activity: activityLevel,
      status: status,
      uptime: uptimeStr,
      source: 'dashboard',
      reputation: evomap ? evomap.reputation_score : null,
      currentTask: currentTaskInfo,
      taskProgress: taskProgress,
      msgCount: chatCount,
      taskDone: taskCount,
      timestamp: new Date().toISOString()
    }));
    return;
  }
  
  // 更新任务计数
  if (url.startsWith('/api/task/')) {
    const action = url.split('/')[3];
    if (action === 'complete') taskCount++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ taskCount }));
    return;
  }
  
  // 更新对话计数
  if (url === '/api/chat') {
    chatCount++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ chatCount }));
    return;
  }
  
  // 技能统计 API
  if (url === '/api/skills' || url === '/api/skills/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    
    const skillsDir = '/home/root/.openclaw/workspace/skills';
    const data = {
      total: 0,
      active: 0,
      list: [],
      categories: {},
      topActive: []
    };
    
    try {
      if (fs.existsSync(skillsDir)) {
        const items = fs.readdirSync(skillsDir);
        const categoryMap = {
          'task-scheduler': 'system',
          'dashboard-service': 'system',
          'bio-memory': 'memory',
          'proactive-agent': 'agent',
          'self-improving-agent': 'agent',
          'task-handler': 'system',
          'weather': 'utility',
          'icloud-calendar': 'integration',
          'daily-reminder': 'utility',
          'news-aggregator-skill': 'news',
          'evomap': 'integration',
          '1password': 'security',
          'healthcheck': 'system',
          'skill-creator': 'development',
          'tavily': 'search'
        };
        
        items.forEach(item => {
          const itemPath = path.join(skillsDir, item);
          if (fs.statSync(itemPath).isDirectory()) {
            const skillMdPath = path.join(itemPath, 'SKILL.md');
            if (fs.existsSync(skillMdPath)) {
              data.total++;
              data.active++;
              const category = categoryMap[item] || 'other';
              data.categories[category] = (data.categories[category] || 0) + 1;
              data.list.push({
                name: item,
                category: category,
                active: true,
                updated: new Date().toISOString().split('T')[0]
              });
            }
          }
        });
      }
    } catch (e) {
      console.error('Error reading skills:', e);
    }
    
    res.end(JSON.stringify(data));
    return;
  }
  
  // 详细技能统计 API
  if (url === '/api/skills/detailed') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    
    // 先获取基础数据
    const skillsDir = '/home/root/.openclaw/workspace/skills';
    const skillsData = { total: 0, active: 0, list: [], categories: {} };
    
    try {
      if (fs.existsSync(skillsDir)) {
        const items = fs.readdirSync(skillsDir);
        const categoryMap = {
          'task-scheduler': 'system', 'dashboard-service': 'system',
          'bio-memory': 'memory', 'proactive-agent': 'agent',
          'self-improving-agent': 'agent', 'task-handler': 'system',
          'weather': 'utility', 'icloud-calendar': 'integration',
          'daily-reminder': 'utility', 'news-aggregator-skill': 'news',
          'evomap': 'integration', '1password': 'security',
          'healthcheck': 'system', 'skill-creator': 'development', 'tavily': 'search'
        };
        
        items.forEach(item => {
          const itemPath = path.join(skillsDir, item);
          if (fs.statSync(itemPath).isDirectory()) {
            const skillMdPath = path.join(itemPath, 'SKILL.md');
            if (fs.existsSync(skillMdPath)) {
              skillsData.total++;
              skillsData.active++;
              const category = categoryMap[item] || 'other';
              skillsData.categories[category] = (skillsData.categories[category] || 0) + 1;
              skillsData.list.push({ name: item, category, active: true });
            }
          }
        });
      }
    } catch (e) {}
    
    res.end(JSON.stringify({
      summary: { total: skillsData.total, active: skillsData.active, inactive: skillsData.total - skillsData.active },
      categories: skillsData.categories,
      recentlyUpdated: skillsData.list.slice(0, 5),
      topActive: skillsData.list.slice(0, 5),
      allSkills: skillsData.list
    }));
    return;
  }
  
  // 系统信息 API
  if (url === '/api/system') {
    apiCalls++;
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    // CPU 使用率
    const cpus = os.cpus();
    let totalIdle = 0, totalTick = 0;
    cpus.forEach(cpu => {
      for (let type in cpu.times) totalTick += cpu.times[type];
      totalIdle += cpu.times.idle;
    });
    const cpuPercent = Math.round((1 - totalIdle / totalTick) * 100);
    
    // 负载平均值
    const loadAvg = os.loadavg();
    
    // 磁盘使用
    let diskPercent = 45;
    try {
      const dfOutput = require('child_process').execSync('df -h / | tail -1').toString();
      const match = dfOutput.match(/(\d+)%/);
      if (match) diskPercent = parseInt(match[1]);
    } catch (e) {}
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      memory: `${Math.round(usedMem / 1024 / 1024)}MB`,
      memoryPercent: Math.round((usedMem / totalMem) * 100),
      memoryUsed: Math.round(usedMem / 1024 / 1024),
      memoryTotal: Math.round(totalMem / 1024 / 1024),
      cpu: String(cpuPercent),
      cpuPercent: cpuPercent,
      disk: `${diskPercent}%`,
      diskPercent: diskPercent,
      loadAvg: loadAvg,
      networkIn: 0,
      networkOut: 0,
      processes: 0,
      uptime: `${Math.floor(os.uptime() / 3600)}h`,
      timestamp: new Date().toISOString(),
      source: 'system'
    }));
    return;
  }
  
  // 更新状态
  if (url.startsWith('/api/status/')) {
    const newStatus = url.split('/')[4];
    addStatusHistory(newStatus);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: newStatus, history: statusHistory.slice(-10) }));
    return;
  }
  
  // Webhook - 接收任务/事件通知 (支持 WebSocket 实时推送)
  // POST /api/webhook with JSON body:
  // { type: 'task_start', data: { task: 'xxx', queue: ['task1'], activity: 70 } }
  // { type: 'task_complete', data: { queue: [], activity: 10 } }
  if (url === '/api/webhook' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { type, data } = payload;

        if (type === 'task_start') {
          currentTaskInfo = data.task || 'Working';
          taskQueue = data.queue || [];
          activityLevel = data.activity || 50;
          taskCount++;
          broadcastTaskUpdate(); // v111.0: 实时推送
        } else if (type === 'task_complete') {
          taskQueue = data.queue || [];
          activityLevel = data.activity || 10;
          currentTaskInfo = taskQueue.length > 0 ? taskQueue.join(', ') : '';
          broadcastTaskUpdate(); // v111.0: 实时推送
        } else if (type === 'state_change') {
          addStatusHistory(data.state);
          broadcast({ type: 'state_change', state: data.state, timestamp: new Date().toISOString() });
        } else if (type === 'activity') {
          activityLevel = data.level || activityLevel;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true, type }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }
  
  // Star Office UI 代理
  if (url.startsWith('/star') || url.startsWith('/office')) {
    serveStarOffice(req, res);
    return;
  }
  
  // v111.0: SSE 端点 - 实时状态流 (必须在 createServer 内部)
  if (url === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    sseClients.add(res);
    console.log(`[SSE] 客户端连接，当前: ${sseClients.size} 个`);

    // 发送初始状态
    res.write(`data: ${JSON.stringify({
      type: 'connected',
      heartbeat: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      activity: activityLevel,
      status: activityLevel > 80 ? 'excited' : activityLevel > 60 ? 'working' : activityLevel < 20 ? 'sleeping' : 'idle',
      msgCount: chatCount,
      taskDone: taskCount,
      currentTask: currentTaskInfo,
      timestamp: new Date().toISOString()
    })}\n\n`);

    // 心跳保持连接
    const heartbeatInterval = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 30000);

    req.on('close', () => {
      clearInterval(heartbeatInterval);
      sseClients.delete(res);
      console.log(`[SSE] 客户端断开，当前: ${sseClients.size} 个`);
    });
    return;
  }
  
  // 默认显示看板
  serveDashboard(req, res);
});

// 定期广播心跳状态 (每5秒) - v111.0
setInterval(() => {
  if (sseClients.size > 0) {
    broadcastSSE({
      type: 'heartbeat',
      heartbeat: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      activity: activityLevel,
      status: activityLevel > 80 ? 'excited' : activityLevel > 60 ? 'working' : activityLevel < 20 ? 'sleeping' : 'idle',
      msgCount: chatCount,
      taskDone: taskCount,
      currentTask: currentTaskInfo,
      timestamp: new Date().toISOString()
    });
  }
}, 5000);

// 任务变更时立即广播 - v111.0
function broadcastTaskUpdate() {
  broadcastSSE({
    type: 'task_update',
    taskCount: taskCount,
    currentTask: currentTaskInfo,
    taskQueue: taskQueue,
    activityLevel: activityLevel,
    timestamp: new Date().toISOString()
  });
}

server.listen(PORT, () => {
  console.log(`🚀 Dashboard 服务已启动: http://localhost:${PORT}`);
  console.log(`📊 看板: http://localhost:${PORT}/`);
  console.log(`🏢 Star Office: http://localhost:${PORT}/star`);
  console.log(`📡 SSE 端点: http://localhost:${PORT}/api/stream`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit());
});
