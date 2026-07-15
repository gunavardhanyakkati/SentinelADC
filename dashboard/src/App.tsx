import React, { useState, useEffect, useRef } from 'react';
import { 
  Activity, 
  Server, 
  Shield, 
  Database, 
  Terminal, 
  RefreshCw, 
  Trash2, 
  Power, 
  Zap, 
  AlertTriangle, 
  Lock, 
  CheckCircle,
  Sliders
} from 'lucide-react';
import { 
  ResponsiveContainer, 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  Tooltip
} from 'recharts';
import './App.css';

// Type definitions
interface BackendServer {
  id: string;
  name: string;
  url: string;
  weight: number;
  activeConnections: number;
  performanceScore: number;
  healthy: boolean;
  overrideStatus?: string | null;
  successRate: number;
}

interface TelemetrySummary {
  throughputRps: number;
  averageLatencyMs: number;
  successRate: number;
  cacheHitRatio: number;
  totalRequests: number;
}

interface HistoricalData {
  timeBucket: string;
  requestCount: number;
  averageLatencyMs: number;
  errorRate: number;
  cacheHitRatio: number;
}

interface BackendStats {
  backendId: string;
  backendUrl: string | null;
  requestCount: number;
  averageLatencyMs: number;
  errorCount: number;
  cacheHitCount: number;
}

interface WafLog {
  id: string;
  type: string;
  ip: string;
  path: string;
  method: string;
  userAgent: string;
  details: {
    reason?: string;
    payload?: string;
  };
  timestamp: string;
}

export default function App() {
  const [token, setToken] = useState<string | null>(localStorage.getItem('sentinel_jwt'));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [activeTab, setActiveTab] = useState<'overview' | 'servers' | 'security' | 'cache' | 'logs'>('overview');
  const [gatewayStatus, setGatewayStatus] = useState<'online' | 'offline'>('offline');
  
  // Real ADC States
  const [algorithm, setAlgorithm] = useState<string>('round-robin');
  const [backends, setBackends] = useState<BackendServer[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetrySummary>({
    throughputRps: 0,
    averageLatencyMs: 0,
    successRate: 100,
    cacheHitRatio: 0,
    totalRequests: 0,
  });
  const [historicalTimeline, setHistoricalTimeline] = useState<HistoricalData[]>([]);
  const [backendStats, setBackendStats] = useState<BackendStats[]>([]);
  const [wafLogs, setWafLogs] = useState<WafLog[]>([]);
  const [blockedIps, setBlockedIps] = useState<string[]>([]);
  
  // Input fields
  const [targetBlockIp, setTargetBlockIp] = useState('');
  const [invalidatePattern, setInvalidatePattern] = useState('');
  const [customLogs, setCustomLogs] = useState<string[]>([]);
  const [filterQuery, setFilterQuery] = useState('');
  const terminalEndRef = useRef<HTMLDivElement>(null);

  // Mocks fallback if local gateway is unreachable
  const enableMockFallback = useRef(true);

  // Handle Login Authentication
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    try {
      const res = await fetch('http://localhost:3000/api/security/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        const data = await res.json();
        setToken(data.token);
        localStorage.setItem('sentinel_jwt', data.token);
        addLogLine('[Auth] Authentication successful. Admin Bearer Token issued.', 'info');
      } else {
        setLoginError('Invalid username or password. (Hint: admin / sentinel)');
      }
    } catch {
      // Offline fallback login for demo
      if (username === 'admin' && password === 'sentinel') {
        const mockToken = 'mock_jwt_token_for_offline_demo';
        setToken(mockToken);
        localStorage.setItem('sentinel_jwt', mockToken);
        addLogLine('[Auth] Gateway offline. Mock offline administrative session started.', 'warn');
      } else {
        setLoginError('Could not reach gateway server. Ensure gateway is running on port 3000.');
      }
    }
  };

  const handleLogout = () => {
    setToken(null);
    localStorage.removeItem('sentinel_jwt');
    addLogLine('[Auth] Logged out. Administrative session terminated.', 'info');
  };

  const addLogLine = (line: string, level: 'info' | 'warn' | 'error' | 'debug' = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    setCustomLogs(prev => [...prev, `[${timestamp}] ${line}::${level}`]);
  };

  // Helper fetch method
  const apiFetch = async (path: string, options: RequestInit = {}) => {
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...options.headers,
    };
    return fetch(`http://localhost:3000${path}`, { ...options, headers });
  };

  // Load Status and Metadata
  const refreshGatewayData = async () => {
    try {
      const res = await fetch('http://localhost:3000/api/status');
      if (res.ok) {
        const data = await res.json();
        setGatewayStatus('online');
        setAlgorithm(data.gateway.algorithm);
        setBackends(data.gateway.backends);
        enableMockFallback.current = false;
      }
    } catch {
      setGatewayStatus('offline');
      if (enableMockFallback.current) {
        loadMockData();
      }
    }
  };

  // Load Telemetry data
  const refreshTelemetryData = async () => {
    if (gatewayStatus === 'offline' && enableMockFallback.current) return;
    try {
      // 1. Realtime summary
      const rtRes = await apiFetch('/api/analytics/realtime');
      if (rtRes.ok) {
        const data = await rtRes.json();
        if (data.dbConnected) setTelemetry(data.summary);
      }
      // 2. Historical timeline
      const histRes = await apiFetch('/api/analytics/historical');
      if (histRes.ok) {
        const data = await histRes.json();
        if (data.dbConnected) setHistoricalTimeline(data.timeline);
      }
      // 3. Backend workload
      const beRes = await apiFetch('/api/analytics/backends');
      if (beRes.ok) {
        const data = await beRes.json();
        if (data.dbConnected) setBackendStats(data.backends);
      }
      // 4. Blocklist IP list
      const blRes = await apiFetch('/api/security/blocklist');
      if (blRes.ok) {
        const list = await blRes.json();
        setBlockedIps(list);
      }
      // 5. WAF Logs
      const logsRes = await apiFetch('/api/security/logs');
      if (logsRes.ok) {
        const logs = await logsRes.json();
        setWafLogs(logs);
      }
    } catch (err: any) {
      addLogLine(`[Telemetry] Failed to refresh live metrics: ${err.message}`, 'error');
    }
  };

  // Mock initializations for standalone/offline dashboard demo
  const loadMockData = () => {
    setAlgorithm('weighted-round-robin');
    setBackends([
      { id: 'backend-1', name: 'backend-1', url: 'http://localhost:4001', weight: 3, activeConnections: 2, performanceScore: 94, healthy: true, successRate: 100 },
      { id: 'backend-2', name: 'backend-2', url: 'http://localhost:4002', weight: 2, activeConnections: 5, performanceScore: 82, healthy: true, successRate: 98 },
      { id: 'backend-3', name: 'backend-3', url: 'http://localhost:4003', weight: 1, activeConnections: 1, performanceScore: 40, healthy: false, successRate: 72 },
    ]);
    setTelemetry({
      throughputRps: 1.84,
      averageLatencyMs: 14.28,
      successRate: 99.4,
      cacheHitRatio: 64.2,
      totalRequests: 824,
    });
    setHistoricalTimeline([
      { timeBucket: '10:00', requestCount: 84, averageLatencyMs: 16.2, errorRate: 0, cacheHitRatio: 62 },
      { timeBucket: '10:01', requestCount: 112, averageLatencyMs: 12.8, errorRate: 1.2, cacheHitRatio: 65 },
      { timeBucket: '10:02', requestCount: 95, averageLatencyMs: 14.1, errorRate: 0.8, cacheHitRatio: 60 },
      { timeBucket: '10:03', requestCount: 130, averageLatencyMs: 11.2, errorRate: 0, cacheHitRatio: 72 },
      { timeBucket: '10:04', requestCount: 145, averageLatencyMs: 18.5, errorRate: 2.1, cacheHitRatio: 58 },
    ]);
    setBackendStats([
      { backendId: 'backend-1', backendUrl: 'http://localhost:4001', requestCount: 420, averageLatencyMs: 8.4, errorCount: 0, cacheHitCount: 310 },
      { backendId: 'backend-2', backendUrl: 'http://localhost:4002', requestCount: 280, averageLatencyMs: 14.8, errorCount: 4, cacheHitCount: 160 },
      { backendId: 'backend-3', backendUrl: 'http://localhost:4003', requestCount: 124, averageLatencyMs: 94.2, errorCount: 12, cacheHitCount: 12 },
    ]);
    setBlockedIps(['192.168.1.105', '45.227.254.12']);
    setWafLogs([
      { id: '1', type: 'sqli', ip: '104.244.42.1', path: '/api/users', method: 'GET', userAgent: 'sqlmap/1.4', details: { reason: 'SQL injection signature detected in query string parameters' }, timestamp: new Date(Date.now() - 4 * 60 * 1000).toISOString() },
      { id: '2', type: 'xss', ip: '198.51.100.12', path: '/', method: 'GET', userAgent: 'Mozilla/5.0', details: { reason: 'XSS script block found in URL body payload' }, timestamp: new Date(Date.now() - 15 * 60 * 1000).toISOString() },
      { id: '3', type: 'rate-limit', ip: '203.0.113.88', path: '/api/security/login', method: 'POST', userAgent: 'Mozilla/5.0', details: { reason: 'Client throughput exceeded 100 requests per minute configuration limit' }, timestamp: new Date(Date.now() - 25 * 60 * 1000).toISOString() },
    ]);
  };

  // Mutation: Change routing algorithm
  const handleAlgorithmChange = async (newAlgo: string) => {
    setAlgorithm(newAlgo);
    addLogLine(`[Gateway] Dispatching dynamic algorithm transition to: ${newAlgo}`, 'info');
    if (gatewayStatus === 'offline') {
      addLogLine('[Gateway] Offline mode active. Algorithm status updated locally.', 'warn');
      return;
    }
    try {
      const res = await apiFetch('/api/admin/algorithm', {
        method: 'PUT',
        body: JSON.stringify({ algorithm: newAlgo }),
      });
      if (res.ok) {
        addLogLine(`[Gateway] Successfully configured routing load balancer mode to: ${newAlgo}`, 'info');
        refreshGatewayData();
      } else {
        addLogLine('[Gateway] Fails to reconfigure load balancer. Check credentials.', 'error');
      }
    } catch (err: any) {
      addLogLine(`[Gateway] HTTP network failure updating algorithm: ${err.message}`, 'error');
    }
  };

  // Mutation: Force node unhealthy status override
  const handleNodeOverride = async (backendId: string, status: string | null) => {
    addLogLine(`[Pools] Dispatching server status override for ${backendId} to ${status || 'default'}`, 'info');
    if (gatewayStatus === 'offline') {
      setBackends(prev => prev.map(s => s.id === backendId ? { ...s, healthy: status === 'healthy' ? true : status === 'unhealthy' ? false : s.healthy, overrideStatus: status } : s));
      return;
    }
    try {
      const res = await apiFetch('/api/health/override', {
        method: 'POST',
        body: JSON.stringify({ backendId, status }),
      });
      if (res.ok) {
        addLogLine(`[Pools] Node status override confirmed for ${backendId}`, 'info');
        refreshGatewayData();
      } else {
        addLogLine('[Pools] Override forbidden. Ensure valid admin auth header present.', 'error');
      }
    } catch (err: any) {
      addLogLine(`[Pools] Node override failed: ${err.message}`, 'error');
    }
  };

  // Mutation: Block a specific IP
  const handleBlockIp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetBlockIp.trim()) return;
    const ip = targetBlockIp.trim();
    addLogLine(`[Firewall] Instructing gateway to block client IP address: ${ip}`, 'warn');
    if (gatewayStatus === 'offline') {
      setBlockedIps(prev => [...prev, ip]);
      setTargetBlockIp('');
      return;
    }
    try {
      const res = await apiFetch('/api/security/blocklist', {
        method: 'POST',
        body: JSON.stringify({ ip }),
      });
      if (res.ok) {
        addLogLine(`[Firewall] Blocklisted IP address successfully: ${ip}`, 'info');
        setTargetBlockIp('');
        refreshTelemetryData();
      } else {
        addLogLine('[Firewall] Could not update firewall rules blocklist.', 'error');
      }
    } catch (err: any) {
      addLogLine(`[Firewall] Blocklist failed: ${err.message}`, 'error');
    }
  };

  // Mutation: Unblock IP
  const handleUnblockIp = async (ip: string) => {
    addLogLine(`[Firewall] Instructing gateway to release client IP: ${ip}`, 'info');
    if (gatewayStatus === 'offline') {
      setBlockedIps(prev => prev.filter(x => x !== ip));
      return;
    }
    try {
      const res = await apiFetch('/api/security/blocklist', {
        method: 'DELETE',
        body: JSON.stringify({ ip }),
      });
      if (res.ok) {
        addLogLine(`[Firewall] IP address released from blocklist: ${ip}`, 'info');
        refreshTelemetryData();
      }
    } catch (err: any) {
      addLogLine(`[Firewall] Unblocklist failed: ${err.message}`, 'error');
    }
  };

  // Mutation: Invalidate cache database
  const handleClearCache = async () => {
    addLogLine('[Cache] Dispatching full cache database FLUSH request', 'warn');
    if (gatewayStatus === 'offline') {
      addLogLine('[Cache] Local database cleared successfully.', 'info');
      return;
    }
    try {
      const res = await apiFetch('/api/cache/clear', { method: 'POST' });
      if (res.ok) {
        addLogLine('[Cache] Cache storage engine cleared successfully.', 'info');
      }
    } catch (err: any) {
      addLogLine(`[Cache] Cache clear failed: ${err.message}`, 'error');
    }
  };

  // Invalidate cache pattern
  const handleInvalidateCache = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!invalidatePattern.trim()) return;
    const pattern = invalidatePattern.trim();
    addLogLine(`[Cache] Invaliding pattern: ${pattern}`, 'info');
    if (gatewayStatus === 'offline') {
      setInvalidatePattern('');
      return;
    }
    try {
      const res = await apiFetch('/api/cache/invalidate', {
        method: 'POST',
        body: JSON.stringify({ pattern }),
      });
      if (res.ok) {
        addLogLine(`[Cache] Invalidated keys matching: ${pattern}`, 'info');
        setInvalidatePattern('');
      }
    } catch (err: any) {
      addLogLine(`[Cache] Invalidation failed: ${err.message}`, 'error');
    }
  };

  // Auto Scroll log terminal to bottom
  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [customLogs]);

  // Initial loads and background polling
  useEffect(() => {
    refreshGatewayData();
    refreshTelemetryData();
    addLogLine('SentinelADC Management console initialized.', 'info');

    const interval = setInterval(() => {
      refreshGatewayData();
      refreshTelemetryData();
    }, 3000);

    return () => clearInterval(interval);
  }, [gatewayStatus, token]);

  // Render Login state
  if (!token) {
    return (
      <div className="login-overlay">
        <div className="glass-panel login-card glow-indigo">
          <div className="login-glow-header">
            <div className="sidebar-logo-glow" style={{ width: '48px', height: '48px', fontSize: '1.4rem' }}>S</div>
            <h1 style={{ fontSize: '2rem', margin: '0' }}>SentinelADC Console</h1>
            <p style={{ textAlign: 'center', margin: '0', fontSize: '0.9rem' }}>
              Sign in to manage reverse proxy, dynamic pools, firewall layers, and analytics telemetry.
            </p>
          </div>
          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary)' }}>ADMINISTRATOR USERNAME</label>
              <input 
                type="text" 
                className="input-field" 
                placeholder="e.g. admin" 
                value={username}
                onChange={e => setUsername(e.target.value)}
                required
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary)' }}>PASSWORD</label>
              <input 
                type="password" 
                className="input-field" 
                placeholder="••••••••" 
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
            </div>
            {loginError && (
              <div style={{ padding: '10px', background: 'var(--color-danger-glow)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '6px', fontSize: '0.8rem', color: 'var(--color-danger)' }}>
                {loginError}
              </div>
            )}
            <button type="submit" className="btn btn-primary" style={{ marginTop: '8px' }}>
              <Lock size={16} /> Sign In
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* Sidebar Navigation */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo-glow">S</div>
          <div className="sidebar-title">SentinelADC</div>
        </div>
        
        <nav className="sidebar-menu">
          <button 
            className={`menu-item ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            <Activity size={18} />
            <span>Overview</span>
          </button>
          
          <button 
            className={`menu-item ${activeTab === 'servers' ? 'active' : ''}`}
            onClick={() => setActiveTab('servers')}
          >
            <Server size={18} />
            <span>Server Pools</span>
          </button>
          
          <button 
            className={`menu-item ${activeTab === 'security' ? 'active' : ''}`}
            onClick={() => setActiveTab('security')}
          >
            <Shield size={18} />
            <span>Security Engine</span>
          </button>
          
          <button 
            className={`menu-item ${activeTab === 'cache' ? 'active' : ''}`}
            onClick={() => setActiveTab('cache')}
          >
            <Database size={18} />
            <span>Cache Analytics</span>
          </button>
          
          <button 
            className={`menu-item ${activeTab === 'logs' ? 'active' : ''}`}
            onClick={() => setActiveTab('logs')}
          >
            <Terminal size={18} />
            <span>System Logs</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="user-profile">
            <div className="avatar">A</div>
            <div className="user-info">
              <span className="user-name">admin</span>
              <span className="user-role">Administrator</span>
            </div>
          </div>
          <button className="logout-btn" onClick={handleLogout} title="Log Out">
            <Power size={16} />
          </button>
        </div>
      </aside>

      {/* Main Content Pane */}
      <main className="content-wrapper">
        <header className="top-bar">
          <div className="page-title-section">
            <h2 style={{ margin: 0, textTransform: 'capitalize' }}>{activeTab} Dashboard</h2>
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
            <div className="header-status">
              <span className={`status-dot ${gatewayStatus === 'online' ? 'active' : ''}`} style={{ backgroundColor: gatewayStatus === 'online' ? 'var(--color-success)' : 'var(--color-danger)' }}></span>
              <span style={{ fontWeight: 600, color: gatewayStatus === 'online' ? '#fff' : 'var(--text-muted)' }}>
                Gateway: {gatewayStatus === 'online' ? 'ONLINE' : 'MOCK FALLBACK'}
              </span>
            </div>
            
            <button 
              className="btn btn-secondary" 
              onClick={() => {
                refreshGatewayData();
                refreshTelemetryData();
                addLogLine('Manual telemetry refresh triggered.', 'debug');
              }}
              style={{ padding: '8px 12px' }}
            >
              <RefreshCw size={14} /> Refresh
            </button>
          </div>
        </header>

        <div className="workspace-area">
          {/* 1. OVERVIEW SCREEN */}
          {activeTab === 'overview' && (
            <div>
              {/* Telemetry metrics metricsRow */}
              <div className="metrics-row">
                <div className="glass-panel metric-card primary glow-indigo">
                  <div className="metric-header">
                    <span>LIVE THROUGHPUT</span>
                    <div className="metric-icon-bg"><Zap size={16} color="var(--color-brand)" /></div>
                  </div>
                  <div className="metric-value">{telemetry.throughputRps}</div>
                  <div className="metric-footer">Requests per second</div>
                </div>

                <div className="glass-panel metric-card info glow-indigo">
                  <div className="metric-header">
                    <span>AVG RESP LATENCY</span>
                    <div className="metric-icon-bg"><Activity size={16} color="var(--color-info)" /></div>
                  </div>
                  <div className="metric-value">{telemetry.averageLatencyMs}ms</div>
                  <div className="metric-footer">Across all routing nodes</div>
                </div>

                <div className="glass-panel metric-card success glow-indigo">
                  <div className="metric-header">
                    <span>SUCCESS RATE</span>
                    <div className="metric-icon-bg"><CheckCircle size={16} color="var(--color-success)" /></div>
                  </div>
                  <div className="metric-value">{telemetry.successRate}%</div>
                  <div className="metric-footer">Transactional 2xx/3xx returns</div>
                </div>

                <div className="glass-panel metric-card warning glow-indigo">
                  <div className="metric-header">
                    <span>CACHE HIT RATIO</span>
                    <div className="metric-icon-bg"><Database size={16} color="var(--color-warning)" /></div>
                  </div>
                  <div className="metric-value">{telemetry.cacheHitRatio}%</div>
                  <div className="metric-footer">Bypassed backend servers</div>
                </div>
              </div>

              {/* Grid with line chart and settings summary */}
              <div className="dashboard-grid">
                <div className="glass-panel glow-indigo">
                  <div className="panel-header">
                    <h3>Historical Performance Timeline</h3>
                    <span className="badge badge-brand">Last 60 Minutes</span>
                  </div>
                  <div className="panel-body">
                    {historicalTimeline.length > 0 ? (
                      <div className="chart-container">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={historicalTimeline} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                            <defs>
                              <linearGradient id="colorLatency" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="var(--color-info)" stopOpacity={0.3}/>
                                <stop offset="95%" stopColor="var(--color-info)" stopOpacity={0}/>
                              </linearGradient>
                              <linearGradient id="colorRequests" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="var(--color-brand)" stopOpacity={0.3}/>
                                <stop offset="95%" stopColor="var(--color-brand)" stopOpacity={0}/>
                              </linearGradient>
                            </defs>
                            <XAxis dataKey="timeBucket" stroke="var(--text-muted)" fontSize={11} tickLine={false} />
                            <YAxis stroke="var(--text-muted)" fontSize={11} tickLine={false} />
                            <Tooltip contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }} />
                            <Area type="monotone" dataKey="averageLatencyMs" stroke="var(--color-info)" strokeWidth={2} fillOpacity={1} fill="url(#colorLatency)" name="Latency (ms)" />
                            <Area type="monotone" dataKey="requestCount" stroke="var(--color-brand)" strokeWidth={2} fillOpacity={1} fill="url(#colorRequests)" name="Requests" />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    ) : (
                      <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
                        <AlertTriangle size={24} style={{ marginBottom: '8px' }} />
                        <p>No historical telemetry database summaries recorded yet. Send traffic to populate.</p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Quick controller console */}
                <div className="glass-panel glow-indigo">
                  <div className="panel-header">
                    <h3>L7 Routing Strategy</h3>
                  </div>
                  <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <label style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary)' }}>ACTIVE LB ALGORITHM</label>
                      <select 
                        className="input-field input-select" 
                        value={algorithm}
                        onChange={e => handleAlgorithmChange(e.target.value)}
                      >
                        <option value="round-robin">Round Robin (Cyclic)</option>
                        <option value="weighted-round-robin">Weighted Round Robin</option>
                        <option value="least-connections">Least Connections</option>
                        <option value="ip-hash">IP Hash (Session Affinity)</option>
                      </select>
                    </div>

                    <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '20px' }}>
                      <h4 style={{ fontSize: '0.9rem', marginBottom: '12px' }}>Operational Highlights</h4>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '0.88rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>Total Backend Pools</span>
                          <span style={{ fontWeight: 600 }}>{backends.length} Active Nodes</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>Firewall Blocked IPs</span>
                          <span style={{ fontWeight: 600 }}>{blockedIps.length} Banned</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>Total Traffic Handled</span>
                          <span style={{ fontWeight: 600 }}>{telemetry.totalRequests} Requests</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 2. SERVERS PANEL */}
          {activeTab === 'servers' && (
            <div>
              <div className="algorithm-selector-box">
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                  <Sliders size={20} color="var(--color-brand)" />
                  <div>
                    <h3 style={{ margin: 0, fontSize: '1.1rem' }}>Active Load Balancing Algorithm</h3>
                    <p style={{ margin: 0, fontSize: '0.85rem' }}>Dynamic reconfiguration updates backend routing parameters on-the-fly.</p>
                  </div>
                </div>
                <div>
                  <select 
                    className="input-field input-select" 
                    value={algorithm}
                    onChange={e => handleAlgorithmChange(e.target.value)}
                    style={{ width: '220px' }}
                  >
                    <option value="round-robin">Round Robin</option>
                    <option value="weighted-round-robin">Weighted Round Robin</option>
                    <option value="least-connections">Least Connections</option>
                    <option value="ip-hash">IP Hash</option>
                  </select>
                </div>
              </div>

              {/* Server Cards Grid */}
              <div className="server-cards-grid">
                {backends.map(srv => {
                  const srvStat = backendStats.find(x => x.backendId === srv.id);
                  return (
                    <div 
                      className={`glass-panel server-card ${srv.healthy ? 'glow-indigo' : 'glow-rose'}`} 
                      key={srv.id}
                    >
                      <div className="server-card-header">
                        <div className="server-title-box">
                          <span className="server-name-label">{srv.name}</span>
                          <span className="server-url-label">{srv.url}</span>
                        </div>
                        <span className={`badge ${srv.healthy ? 'badge-success' : 'badge-danger'}`}>
                          {srv.healthy ? 'Online' : 'Offline'}
                        </span>
                      </div>

                      <div className="server-metrics-grid">
                        <div className="srv-metric">
                          <span className="srv-metric-label">WEIGHT</span>
                          <span className="srv-metric-value">{srv.weight}</span>
                        </div>
                        <div className="srv-metric">
                          <span className="srv-metric-label">ACTIVE CONNS</span>
                          <span className="srv-metric-value">{srv.activeConnections}</span>
                        </div>
                        <div className="srv-metric">
                          <span className="srv-metric-label">SCORE</span>
                          <span className="srv-metric-value" style={{ color: srv.performanceScore > 80 ? 'var(--color-success)' : srv.performanceScore > 50 ? 'var(--color-warning)' : 'var(--color-danger)' }}>
                            {srv.performanceScore}/100
                          </span>
                        </div>
                        <div className="srv-metric">
                          <span className="srv-metric-label">TOTAL REQS</span>
                          <span className="srv-metric-value">{srvStat ? srvStat.requestCount : 0}</span>
                        </div>
                      </div>

                      <div className="server-controls">
                        {srv.overrideStatus === 'unhealthy' ? (
                          <button 
                            className="btn btn-secondary" 
                            style={{ flexGrow: 1, padding: '8px' }}
                            onClick={() => handleNodeOverride(srv.id, null)}
                          >
                            Rejoin Pool
                          </button>
                        ) : (
                          <button 
                            className="btn btn-danger" 
                            style={{ flexGrow: 1, padding: '8px' }}
                            onClick={() => handleNodeOverride(srv.id, 'unhealthy')}
                          >
                            Drain / Kill
                          </button>
                        )}
                        
                        {srv.overrideStatus !== 'healthy' && (
                          <button 
                            className="btn btn-primary" 
                            style={{ flexGrow: 1, padding: '8px', background: 'var(--color-success)', boxShadow: 'none' }}
                            onClick={() => handleNodeOverride(srv.id, 'healthy')}
                          >
                            Force Up
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 3. SECURITY VIEW */}
          {activeTab === 'security' && (
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.2fr', gap: '24px' }}>
              {/* Audit trail panel */}
              <div className="glass-panel glow-indigo">
                <div className="panel-header">
                  <h3>WAF Threat Mitigation Log</h3>
                  <span className="badge badge-danger">Intrusion Prevention</span>
                </div>
                <div className="panel-body" style={{ padding: 0 }}>
                  <div className="data-table-container">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>TIMESTAMP</th>
                          <th>IP ADDRESS</th>
                          <th>METHOD & URI</th>
                          <th>TYPE</th>
                          <th>ACTION</th>
                        </tr>
                      </thead>
                      <tbody>
                        {wafLogs.length > 0 ? (
                          wafLogs.map(log => (
                            <tr key={log.id}>
                              <td style={{ fontSize: '0.8rem', fontFamily: 'var(--font-mono)' }}>
                                {new Date(log.timestamp).toLocaleTimeString()}
                              </td>
                              <td style={{ fontWeight: 600 }}>{log.ip}</td>
                              <td>
                                <span className="badge badge-muted" style={{ marginRight: '6px' }}>{log.method}</span>
                                <code style={{ fontSize: '0.82rem' }}>{log.path}</code>
                              </td>
                              <td>
                                <span className={`badge ${log.type === 'sqli' || log.type === 'xss' ? 'badge-danger' : 'badge-warning'}`}>
                                  {log.type}
                                </span>
                              </td>
                              <td>
                                <button 
                                  className="btn btn-secondary" 
                                  style={{ padding: '4px 8px', fontSize: '0.75rem', borderColor: 'var(--color-danger)', color: 'var(--color-danger)' }}
                                  onClick={() => {
                                    setTargetBlockIp(log.ip);
                                    addLogLine(`[Firewall] Preparing block trigger for ip: ${log.ip}`, 'info');
                                  }}
                                >
                                  Ban IP
                                </button>
                              </td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={5} style={{ textAlign: 'center', padding: '32px', color: 'var(--text-muted)' }}>
                              No security threat events recorded by WAF middleware.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* Blocklist Panel */}
              <div className="glass-panel glow-indigo">
                <div className="panel-header">
                  <h3>Firewall Access Lists</h3>
                </div>
                <div className="panel-body">
                  <form onSubmit={handleBlockIp} style={{ display: 'flex', gap: '10px', marginBottom: '24px' }}>
                    <input 
                      type="text" 
                      className="input-field" 
                      placeholder="Enter IP (e.g. 192.168.1.5)" 
                      value={targetBlockIp}
                      onChange={e => setTargetBlockIp(e.target.value)}
                    />
                    <button type="submit" className="btn btn-danger" style={{ whiteSpace: 'nowrap' }}>
                      Block IP
                    </button>
                  </form>

                  <h4 style={{ fontSize: '0.9rem', marginBottom: '12px' }}>Active Blocklisted IPs ({blockedIps.length})</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {blockedIps.length > 0 ? (
                      blockedIps.map(ip => (
                        <div 
                          key={ip}
                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'rgba(239, 68, 68, 0.05)', border: '1px solid rgba(239, 68, 68, 0.15)', borderRadius: '8px' }}
                        >
                          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--color-danger)' }}>{ip}</span>
                          <button 
                            style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
                            onClick={() => handleUnblockIp(ip)}
                            title="Unblock Client"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))
                    ) : (
                      <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', border: '1px dashed var(--border-color)', borderRadius: '8px' }}>
                        No client IPs currently blocked in the firewall.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 4. CACHE VIEW */}
          {activeTab === 'cache' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
              {/* Cache Telemetry Panel */}
              <div className="glass-panel glow-indigo">
                <div className="panel-header">
                  <h3>Cache Efficiency metrics</h3>
                </div>
                <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                    <div style={{ padding: '20px', background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>CACHE SAVED RATIO</span>
                      <div style={{ fontSize: '1.8rem', fontWeight: 700, color: 'var(--color-warning)', marginTop: '8px' }}>
                        {telemetry.cacheHitRatio}%
                      </div>
                    </div>
                    <div style={{ padding: '20px', background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>TOTAL GET CACHED</span>
                      <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#fff', marginTop: '8px' }}>
                        {Math.round(telemetry.totalRequests * (telemetry.cacheHitRatio / 100))} Reqs
                      </div>
                    </div>
                  </div>

                  <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '20px' }}>
                    <h4 style={{ fontSize: '0.9rem', marginBottom: '12px' }}>Estimated Performance Savings</h4>
                    <p style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
                      Incoming GET requests served via Redis Cache bypass the backend Node pools entirely, saving approximately <b>{(telemetry.averageLatencyMs * 4).toFixed(1)}ms</b> of network transmission overhead.
                    </p>
                  </div>
                </div>
              </div>

              {/* Cache Management Panel */}
              <div className="glass-panel glow-indigo">
                <div className="panel-header">
                  <h3>Cache Eviction Console</h3>
                </div>
                <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                  <div>
                    <h4 style={{ fontSize: '0.9rem', marginBottom: '8px' }}>FLUSH REDIS CACHE</h4>
                    <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
                      Evicts every single cached key registered under the Sentinel gateway cache database namespace.
                    </p>
                    <button className="btn btn-danger" onClick={handleClearCache} style={{ width: '100%' }}>
                      <Trash2 size={16} /> Evict Entire Cache Store
                    </button>
                  </div>

                  <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '24px' }}>
                    <h4 style={{ fontSize: '0.9rem', marginBottom: '8px' }}>INVALIDATE KEY PATTERN</h4>
                    <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
                      Evicts specific namespaces or wildcard keys (e.g. `sentinel:cache:/api*`).
                    </p>
                    <form onSubmit={handleInvalidateCache} style={{ display: 'flex', gap: '10px' }}>
                      <input 
                        type="text" 
                        className="input-field" 
                        placeholder="e.g. sentinel:cache:/users" 
                        value={invalidatePattern}
                        onChange={e => setInvalidatePattern(e.target.value)}
                      />
                      <button type="submit" className="btn btn-primary" style={{ whiteSpace: 'nowrap' }}>
                        Invalidate
                      </button>
                    </form>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 5. LOG SYSTEM VIEW */}
          {activeTab === 'logs' && (
            <div className="glass-panel glow-indigo">
              <div className="panel-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <Terminal size={18} color="var(--color-brand)" />
                  <h3 style={{ margin: 0 }}>System Observability Console</h3>
                </div>
                <div style={{ display: 'flex', gap: '12px' }}>
                  <input 
                    type="text" 
                    className="input-field" 
                    placeholder="Filter by Correlation ID / keyword..." 
                    value={filterQuery}
                    onChange={e => setFilterQuery(e.target.value)}
                    style={{ width: '280px', padding: '6px 12px' }}
                  />
                  <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={() => setCustomLogs([])}>
                    Clear Screen
                  </button>
                </div>
              </div>
              
              <div className="panel-body">
                <div className="terminal-container">
                  <div className="terminal-header">
                    <span>SentinelADC Tracing Logs Output</span>
                    <span style={{ fontSize: '0.75rem', opacity: 0.6 }}>ACTIVE LISTENER</span>
                  </div>
                  <div className="terminal-body">
                    {customLogs
                      .filter(line => !filterQuery || line.toLowerCase().includes(filterQuery.toLowerCase()))
                      .map((log, idx) => {
                        const [content, level] = log.split('::');
                        return (
                          <div className={`term-line ${level || 'info'}`} key={idx}>
                            {content}
                          </div>
                        );
                      })}
                    <div ref={terminalEndRef} />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
