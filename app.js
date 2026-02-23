// app.js — refactored, guarded, documented in-place

(function () {
    'use strict';

    // Guard: prevent double-loading the script
    if (typeof window !== 'undefined' && window.__APP_JS_INITIALIZED) return;
    if (typeof window !== 'undefined') window.__APP_JS_INITIALIZED = true;

    const APP_VERSION = "1.1.7";
    console.log(`GPTNotify Frontend App Version: ${APP_VERSION}`);
    console.log('DEBUG: Application starting...');

    // Base URL resolution: local dev vs. file:// vs. deployed
    const API_BASE_URL = (() => {
        const { protocol, hostname, port, pathname, origin } = window.location;
        console.log('DEBUG: Window location:', { protocol, hostname, port, pathname, origin });
        if (protocol === 'file:') return 'http://localhost:5000';
        if (hostname === 'localhost' || hostname === '127.0.0.1') {
            return port === '5000' ? '' : `http://${hostname}:5000`;
        }
        const derived = window.location.origin + (pathname.startsWith('/intelli.ai') ? '/intelli.ai' : '');
        console.log('DEBUG: Derived API_BASE_URL:', derived);
        return derived;
    })();
    if (typeof window !== 'undefined') window.API_BASE_URL = API_BASE_URL;

    // Data source: GitHub raw — "data" branch
    const GITHUB_REPO_URL = 'https://raw.githubusercontent.com/FelixKras/intelli.ai/refs/heads/data';
    const IS_LOCAL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'file:';
    console.log('DEBUG: Config:', { API_BASE_URL, GITHUB_REPO_URL, IS_LOCAL });

    // State holders
    let currentRelevantHeadlines = [];
    let currentAllHeadlines = [];
    let allHeadlinesData = []; // Store full dataset for chart re-render
    let probabilityChart = null;
    let nextUpdateTimer = null;
    let refreshInterval = 10000; // ms
    let refreshTimer = 0;
    let lastDataKey = null;

    // DOM cache
    const el = {
        refreshProgressBar: document.getElementById('refreshProgressBar'),
        statusText: document.getElementById('statusText'),
        statusBadge: document.getElementById('statusBadge'),
        liveness: document.getElementById('liveness'),

        runtime: document.getElementById('runtime'),
        articlesProcessed: document.getElementById('articlesProcessed'),
        notificationsSent: document.getElementById('notificationsSent'),
        ingestRate: document.getElementById('ingestRate'),
        articleLag: document.getElementById('articleLag'),
        apiSuccessRate: document.getElementById('apiSuccessRate'),
        errors: document.getElementById('errors'),
        heartbeatsSent: document.getElementById('heartbeatsSent'),
        nextUpdate: document.getElementById('nextUpdate'),
        analysisModel: document.getElementById('analysisModel'),
        jokesModel: document.getElementById('jokesModel'),
        lastDataUpdate: document.getElementById('lastDataUpdate'),

        maxProbability: document.getElementById('maxProbability'),
        maxProbSource: document.getElementById('maxProbSource'),
        maxProbValue: document.getElementById('maxProbValue'),
        maxProbHeadline: document.getElementById('maxProbHeadline'),
        maxProbTime: document.getElementById('maxProbTime'),
        severityBadge: document.getElementById('severityBadge'),

        relevantHeadlinesContainer: document.getElementById('relevantHeadlinesContainer'),
        relevantHeadlineCount: document.getElementById('relevantHeadlineCount'),
        allHeadlinesContainer: document.getElementById('allHeadlinesContainer'),
        allHeadlinesCount: document.getElementById('allHeadlinesCount'),

        probabilityChart: document.getElementById('probabilityChart'),
        toggleRaw: document.getElementById('toggleRaw'),
        toggleSmoothed: document.getElementById('toggleSmoothed'),

        jokesContainer: document.getElementById('jokesContainer'),
        stocksContainer: document.getElementById('stocksContainer'),

        xkcdImage: document.getElementById('xkcdImage'),
        lastUpdated: document.getElementById('lastUpdated'),
        backendVersionDisplay: document.getElementById('backendVersionDisplay'),
        headerVersionDisplay: document.getElementById('headerVersionDisplay'),
        metricsFrontendVersion: document.getElementById('metricsFrontendVersion'),

        relevantSortBy: document.getElementById('relevantSortBy'),
        relevantSortOrder: document.getElementById('relevantSortOrder'),
        allSortBy: document.getElementById('allSortBy'),
        allSortOrder: document.getElementById('allSortOrder'),
    };

    const skeletonNodes = document.querySelectorAll('.skeleton');
    const rootContainer = document.querySelector('.max-w-7xl');

    // ── Utilities ─────────────────────────────────────────────
    const pad2 = (n) => String(n).padStart(2, '0');
    const pct = (p) => `${Math.round(p)}%`;

    function formatDuration(seconds) {
        if (seconds < 0) return '00:00:00';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
    }

    function formatTimestamp(iso) {
        if (!iso) return 'N/A';
        const d = new Date(iso.replace(' ', 'T'));
        if (isNaN(d)) return iso;
        return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    }

    function getSeverity(prob) {
        if (prob >= 85) return { label: 'Critical', cls: 'bg-red-600 text-white', lg: 'text-red-500' };
        if (prob >= 70) return { label: 'High', cls: 'bg-orange-500 text-white', lg: 'text-orange-500' };
        if (prob >= 55) return { label: 'Medium', cls: 'bg-yellow-400 text-slate-900', lg: 'text-yellow-400' };
        if (prob >= 40) return { label: 'Low', cls: 'bg-slate-200 text-slate-900', lg: 'text-slate-400' };
        return { label: 'Info', cls: 'bg-slate-100 text-slate-700', lg: 'text-slate-500' };
    }

    function sortHeadlines(headlines, sortBy, sortOrder) {
        return [...headlines].sort((a, b) => {
            if (sortBy === 'probability') {
                return sortOrder === 'desc' ? b.probability - a.probability : a.probability - b.probability;
            }
            const da = a.datetime_iso ? new Date(a.datetime_iso) : new Date(0);
            const db = b.datetime_iso ? new Date(b.datetime_iso) : new Date(0);
            return sortOrder === 'desc' ? db - da : da - db;
        });
    }

    // ── Refresh progress bar ──────────────────────────────────
    function updateRefreshProgress() {
        if (!el.refreshProgressBar) return;
        refreshTimer += 100;
        el.refreshProgressBar.style.width = `${Math.min((refreshTimer / refreshInterval) * 100, 100)}%`;
        if (refreshTimer >= refreshInterval) refreshTimer = 0;
    }

    // ── Countdown to next update ──────────────────────────────
    function startNextUpdateCountdown(nextIso) {
        if (nextUpdateTimer) clearInterval(nextUpdateTimer);
        if (!nextIso) return;
        const target = new Date(nextIso.replace(' ', 'T')).getTime();
        nextUpdateTimer = setInterval(() => {
            const diff = target - Date.now();
            if (diff < 0) {
                if (el.nextUpdate) el.nextUpdate.textContent = 'Soon';
                clearInterval(nextUpdateTimer);
            } else {
                const m = Math.floor((diff % 3600000) / 60000);
                const s = Math.floor((diff % 60000) / 1000);
                if (el.nextUpdate) el.nextUpdate.textContent = `${m}m ${s}s`;
            }
        }, 1000);
    }

    // ── Status UI ────────────────────────────────────────────
    function updateStatus(online) {
        const color = online ? 'emerald' : 'red';
        const label = online ? 'Online' : 'Offline';
        const liveLabel = online ? 'Online' : 'Error';
        if (el.statusText) {
            el.statusText.textContent = label;
            el.statusText.className = `text-${color}-300`;
        }
        if (el.statusBadge) {
            el.statusBadge.className = `text-xs px-2 py-1 rounded-md bg-slate-900 border border-slate-800 text-${color}-300`;
        }
        if (el.liveness) {
            el.liveness.textContent = liveLabel;
            el.liveness.className = `mt-1 text-2xl font-bold text-${color}-300`;
        }
    }

    // ── Metrics rendering ─────────────────────────────────────
    function updateMetrics(m) {
        if (el.runtime) el.runtime.textContent = formatDuration(m.runtime_seconds);
        if (el.articlesProcessed) el.articlesProcessed.textContent = m.articles_processed || 0;
        if (el.notificationsSent) el.notificationsSent.textContent = m.notifications_sent || 0;
        if (el.ingestRate) el.ingestRate.textContent = `${(m.ingest_rate_per_min || 0).toFixed(2)}/min`;
        if (el.articleLag) el.articleLag.textContent = m.lag_minutes != null ? `${m.lag_minutes.toFixed(1)}m` : '--';
        if (el.apiSuccessRate) el.apiSuccessRate.textContent = `${(m.api_success_rate || 0).toFixed(1)}%`;
        if (el.errors) el.errors.textContent = m.errors_encountered || 0;
        if (el.heartbeatsSent) el.heartbeatsSent.textContent = m.telegram_heartbeats_sent || 0;
        if (el.backendVersionDisplay && m.version) el.backendVersionDisplay.textContent = `v${m.version}`;
        const t = m.time_until_next_update_seconds;
        if (el.nextUpdate) {
            if (t != null && t > 0) el.nextUpdate.textContent = `${Math.floor(t / 60)}m ${Math.floor(t % 60)}s`;
            else el.nextUpdate.textContent = 'Soon';
        }
    }

    // ── Headline card template ────────────────────────────────
    function headlineCard(h) {
        const sev = getSeverity(h.probability);
        const time = h.datetime_iso ? formatTimestamp(h.datetime_iso) : 'N/A';
        return `<div class="headline-card fade-in">
            <div class="flex items-start justify-between gap-3">
                <div class="flex-1">
                    <div class="text-sm font-medium text-slate-200">${h.headline}</div>
                    <div class="mt-1 text-xs text-slate-400">Keywords: ${h.keywords || 'N/A'}</div>
                </div>
                <span class="text-xs px-2 py-1 rounded-md ${sev.cls}">${h.probability}%</span>
            </div>
            <div class="mt-2 flex items-center gap-2">
                <span class="text-xs text-slate-500">Source:</span>
                <span class="text-xs font-semibold text-slate-300">${h.source}</span>
                <span class="text-xs text-slate-500">•</span>
                <span class="text-xs text-slate-400">${h.source_type || 'Unknown'}</span>
                <span class="text-xs text-slate-500">•</span>
                <span class="text-xs text-slate-400">${time}</span>
            </div>
        </div>`;
    }

    function renderHeadlines(headlines, container, countEl, sortBy = 'date', sortOrder = 'desc') {
        if (!container) return;
        if (!headlines || !headlines.length) {
            container.innerHTML = '<div class="text-center py-6 text-slate-400">No headlines available</div>';
            if (countEl) countEl.textContent = '0 headlines';
            return;
        }
        const sorted = sortHeadlines(headlines, sortBy, sortOrder);
        if (countEl) countEl.textContent = `${sorted.length} headlines`;
        container.innerHTML = sorted.map(headlineCard).join('');
    }

    // ── Probability chart ─────────────────────────────────────
    function renderProbabilityChart(headlines) {
        if (!el.probabilityChart) return;
        const ctx = el.probabilityChart.getContext('2d');
        if (!ctx) return;

        function rollingMean(points, windowSize = 5) {
            const out = [];
            let sum = 0;
            let queue = [];
            for (let i = 0; i < points.length; i++) {
                sum += points[i].y;
                queue.push(points[i].y);
                if (queue.length > windowSize) sum -= queue.shift();
                out.push({ x: points[i].x, y: sum / queue.length, headline: 'Mean of last ' + queue.length + ' pts' });
            }
            return out;
        }

        let latest = null;
        for (const h of headlines) {
            if (!h.datetime_iso) continue;
            const d = new Date(h.datetime_iso.replace(' ', 'T'));
            if (!latest || d > latest) latest = d;
        }
        const nowRef = latest || new Date();
        const ago5d = new Date(nowRef.getTime() - 5 * 86400000);

        const rawPoints = headlines
            .map(h => {
                if (!h.datetime_iso) return null;
                const d = new Date(h.datetime_iso.replace(' ', 'T'));
                return { x: d, y: h.probability, headline: h.headline };
            })
            .filter(p => p && p.y >= 50 && p.x >= ago5d)
            .sort((a, b) => a.x - b.x);

        const smoothedPoints = rollingMean(rawPoints, 5);

        if (probabilityChart) probabilityChart.destroy();

        const showRaw = el.toggleRaw ? el.toggleRaw.checked : true;
        const showSmoothed = el.toggleSmoothed ? el.toggleSmoothed.checked : true;

        probabilityChart = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [
                    {
                        label: 'Probability % (raw)',
                        data: rawPoints,
                        borderColor: 'rgba(52, 211, 153, 0.65)',
                        backgroundColor: 'rgba(52, 211, 153, 0.08)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.25,
                        pointRadius: 4,
                        pointHitRadius: 10,
                        pointHoverRadius: 6,
                        pointBackgroundColor: 'rgb(52, 211, 153)',
                        hidden: !showRaw
                    },
                    {
                        label: 'Mean (SMA)',
                        data: smoothedPoints,
                        borderColor: 'rgb(94, 234, 212)',
                        backgroundColor: 'rgba(94, 234, 212, 0.05)',
                        borderWidth: 2,
                        fill: false,
                        tension: 0.3,
                        pointRadius: 0,
                        pointHitRadius: 8,
                        pointHoverRadius: 0,
                        hidden: !showSmoothed
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { intersect: false, mode: 'index' },
                scales: {
                    x: {
                        type: 'time',
                        time: { unit: 'day', displayFormats: { day: 'MMM d' } },
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        ticks: { color: 'rgba(255,255,255,0.5)', font: { size: 10 } }
                    },
                    y: {
                        beginAtZero: true,
                        max: 100,
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        ticks: {
                            color: 'rgba(255,255,255,0.5)',
                            font: { size: 10 },
                            callback: v => v + '%'
                        }
                    }
                },
                plugins: {
                    legend: { display: true, labels: { color: 'rgba(255,255,255,0.7)', font: { size: 11 } } },
                    tooltip: {
                        backgroundColor: 'rgba(15,23,42,0.95)',
                        titleColor: 'rgb(226,232,240)',
                        bodyColor: 'rgb(226,232,240)',
                        borderColor: 'rgb(52,211,153)',
                        borderWidth: 1,
                        padding: 10,
                        displayColors: false,
                        callbacks: {
                            label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%`,
                            afterLabel: ctx => {
                                const hl = ctx.raw?.headline;
                                if (!hl) return '';
                                const words = hl.split(' ');
                                const lines = [''];
                                let cur = 0;
                                for (const w of words) {
                                    if ((lines[cur] + w).length > 40) { cur++; lines[cur] = ''; }
                                    lines[cur] += w + ' ';
                                }
                                return ['', 'Headline:', ...lines];
                            }
                        }
                    }
                }
            }
        });
    }

    // ── Jokes renderer ────────────────────────────────────────
    function renderJokes(jokes) {
        if (!el.jokesContainer) return;
        if (!jokes || !jokes.length) {
            el.jokesContainer.innerHTML = '<div class="text-slate-400 text-sm">No jokes generated yet.</div>';
            return;
        }
        el.jokesContainer.innerHTML = jokes.slice(0, 5).map(joke => {
            const text = (typeof joke === 'object' && joke !== null && 'joke' in joke) ? joke.joke : joke;
            return `<div class="rounded-lg bg-slate-950/40 border border-slate-800 p-3 text-sm text-slate-200">${text}</div>`;
        }).join('');
    }

    // ── Stock cards renderer ──────────────────────────────────
    function stockCard(stock) {
        const meta = stock.metadata || {};
        const name = meta.company_name || stock.ticker || 'N/A';
        const state = meta.market_state || 'UNKNOWN';
        const trend = meta.expected_trend || 'NEUTRAL';
        const price = meta.price ? meta.price.toFixed(2) : 'N/A';
        const chg = meta.change_percent || 0;

        const pos = chg >= 0;
        const color = pos ? 'emerald' : 'red';
        const arrow = pos ? '↑' : '↓';
        const trendColor = trend === 'UP' ? 'text-emerald-400' : trend === 'DOWN' ? 'text-red-400' : 'text-slate-400';

        let stateBadge = 'bg-slate-800 text-slate-400';
        if (state === 'REGULAR') stateBadge = 'bg-blue-900/40 text-blue-400 border border-blue-800/50';
        else if (state === 'PRE' || state === 'POST') stateBadge = 'bg-amber-900/40 text-amber-400 border border-amber-800/50';

        return `<div class="rounded-lg bg-slate-950/50 border border-${color}-900/30 p-3 hover:bg-slate-950/70 transition-colors">
            <div class="flex items-start justify-between gap-2">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                        <span class="text-sm font-bold text-slate-100">${name}</span>
                        <span class="text-[10px] px-1.5 py-0.5 rounded ${stateBadge} font-medium uppercase">${state}</span>
                    </div>
                    <div class="mt-1 flex items-center gap-2">
                        <span class="text-[10px] text-slate-500 uppercase">Trend:</span>
                        <span class="text-[10px] font-bold ${trendColor}">${trend}</span>
                    </div>
                </div>
                <div class="text-right">
                    <div class="text-lg font-bold text-slate-200 font-mono">${"$"}${price}</div>
                    <div class="text-xs font-semibold text-${color}-400">${arrow} ${Math.abs(chg).toFixed(2)}%</div>
                </div>
            </div>
        </div>`;
    }

    function renderStocks(stocks) {
        if (!el.stocksContainer) return;
        if (!stocks || !stocks.length) {
            el.stocksContainer.innerHTML = '<div class="text-slate-400 text-sm py-4 text-center">Market closed or data unavailable</div>';
            return;
        }
        el.stocksContainer.innerHTML = stocks.map(stockCard).join('');
    }

    // ── Fetch + render pipeline ───────────────────────────────
    async function fetchData() {
        console.log('DEBUG: fetchData called');
        if (rootContainer) rootContainer.classList.add('updating');
        refreshTimer = 0;

        try {
            const bust = `?v=${Date.now()}`;
            let metrics, headlinesData;

            const tryLocalFirst = IS_LOCAL;
            console.log('DEBUG: Fetch strategy:', { tryLocalFirst, bust });

            if (tryLocalFirst) {
                try {
                    console.log(`DEBUG: Attempting local API fetch from: ${API_BASE_URL}/api/metrics${bust}`);
                    const [mRes, hRes] = await Promise.all([
                        fetch(`${API_BASE_URL}/api/metrics${bust}`),
                        fetch(`${API_BASE_URL}/api/headlines${bust}`)
                    ]);
                    if (mRes.ok && hRes.ok) {
                        metrics = await mRes.json();
                        headlinesData = await hRes.json();
                        console.log('DEBUG: Local API fetch successful');
                    } else {
                        console.warn('DEBUG: Local API fetch failed (not ok). Status:', mRes.status, hRes.status);
                    }
                } catch (e) {
                    console.warn('DEBUG: Local API fetch exception:', e);
                }
            }

            // Fallback / primary: GitHub data branch
            if (!metrics || !headlinesData) {
                console.log(`DEBUG: Attempting GitHub fetch from: ${GITHUB_REPO_URL}/metrics.json${bust}`);
                const [mRes, hRes] = await Promise.all([
                    fetch(`${GITHUB_REPO_URL}/metrics.json${bust}`),
                    fetch(`${GITHUB_REPO_URL}/headlines.json${bust}`)
                ]);
                if (!mRes.ok || !hRes.ok) {
                    console.error('DEBUG: GitHub fetch failed. Status:', mRes.status, hRes.status);
                    throw new Error(`Could not fetch core data from GitHub. Status: ${mRes.status}, ${hRes.status}`);
                }
                metrics = await mRes.json();
                headlinesData = await hRes.json();
                console.log('DEBUG: GitHub fetch successful');
            }

            // Lightweight change detection
            const key = [
                metrics?.last_updated || '',
                headlinesData?.last_updated || '',
                (headlinesData?.current_headlines || []).length,
                (headlinesData?.history_headlines || []).length,
                headlinesData?.overall_probability || ''
            ].join('|');
            if (key === lastDataKey) return;
            lastDataKey = key;

            updateStatus(true);
            skeletonNodes.forEach(n => n.classList.remove('skeleton', 'h-24', 'h-7', 'h-5', 'h-20', 'w-48', 'w-full', 'w-24', 'w-3/4'));

            if (metrics) {
                updateMetrics(metrics);
                if (el.analysisModel) el.analysisModel.textContent = metrics.analysis_model || '';
                if (el.jokesModel) el.jokesModel.textContent = metrics.jokes_model || '';
                if (metrics.last_updated && el.lastDataUpdate) el.lastDataUpdate.textContent = formatTimestamp(metrics.last_updated);
                if (metrics.next_update_time) startNextUpdateCountdown(metrics.next_update_time);
            }

            if (headlinesData) {
                const current = headlinesData.current_headlines || [];
                const history = headlinesData.history_headlines || [];
                const all = [...current, ...history];
                allHeadlinesData = all; // Store for toggling

                const serverTime = new Date((metrics?.last_updated || new Date().toISOString()).replace(' ', 'T'));
                const ago24h = new Date(serverTime - 86400000);
                const ago2d = new Date(serverTime - 2 * 86400000);
                const ago5d = new Date(serverTime - 5 * 86400000);

                let top = null;
                for (const h of all) {
                    const d = h.datetime_iso ? new Date(h.datetime_iso) : null;
                    if (!d || d < ago24h) continue;
                    if (!top || h.probability > top.probability) top = h;
                }

                if (top) {
                    const sev = getSeverity(top.probability);
                    if (el.maxProbability) {
                        el.maxProbability.textContent = pct(top.probability);
                        el.maxProbability.className = `mt-3 text-9xl font-black tracking-tight ${sev.lg}`;
                    }
                    if (el.maxProbSource) el.maxProbSource.textContent = `${top.source || '—'} (${top.source_type || 'Unknown'})`;
                    if (el.maxProbValue) el.maxProbValue.textContent = `${top.probability}%`;
                    if (el.maxProbHeadline) el.maxProbHeadline.textContent = top.headline;
                    if (el.maxProbTime) el.maxProbTime.textContent = formatTimestamp(top.datetime_iso);
                    if (el.severityBadge) {
                        el.severityBadge.textContent = sev.label;
                        el.severityBadge.className = `text-sm px-3 py-1.5 rounded-md ${sev.cls}`;
                    }
                } else {
                    if (el.maxProbability) el.maxProbability.textContent = '--';
                    if (el.maxProbSource) el.maxProbSource.textContent = '—';
                    if (el.maxProbValue) el.maxProbValue.textContent = '—';
                    if (el.maxProbHeadline) el.maxProbHeadline.textContent = 'No headlines in the last 24 hours.';
                    if (el.maxProbTime) el.maxProbTime.textContent = '—';
                    if (el.severityBadge) {
                        el.severityBadge.textContent = 'Info';
                        el.severityBadge.className = 'text-sm px-3 py-1.5 rounded-md bg-slate-200 text-slate-900';
                    }
                }

                const filtered = [];
                const relevant = [];
                for (const h of all) {
                    const d = h.datetime_iso ? new Date(h.datetime_iso) : null;
                    if (!d) continue;
                    if (h.probability >= 50) {
                        if (d >= ago5d) { filtered.push(h); relevant.push(h); }
                    } else if (d >= ago2d) {
                        filtered.push(h);
                    }
                }

                currentRelevantHeadlines = relevant;
                currentAllHeadlines = filtered;

                const rSortBy = el.relevantSortBy?.value || 'date';
                const rSortOrder = el.relevantSortOrder?.value || 'desc';
                const aSortBy = el.allSortBy?.value || 'date';
                const aSortOrder = el.allSortOrder?.value || 'desc';

                renderHeadlines(relevant, el.relevantHeadlinesContainer, el.relevantHeadlineCount, rSortBy, rSortOrder);
                renderHeadlines(filtered, el.allHeadlinesContainer, el.allHeadlinesCount, aSortBy, aSortOrder);
                renderProbabilityChart(all);
            }

            const jokes = headlinesData?.jokes || (headlinesData?.joke ? [headlinesData.joke] : []);
            renderJokes(jokes);

            renderStocks(headlinesData?.stocks || []);

            if (el.xkcdImage) {
                if (headlinesData?.xkcd_comic_base64) {
                    el.xkcdImage.src = headlinesData.xkcd_comic_base64;
                } else {
                    el.xkcdImage.src = `${GITHUB_REPO_URL}/xkcd_comic.png?v=${Date.now()}`;
                }
            }

            if (el.lastUpdated) el.lastUpdated.textContent = new Date().toLocaleTimeString();

        } catch (err) {
            console.error('Error fetching data:', err);
            updateStatus(false);
        } finally {
            if (rootContainer) rootContainer.classList.remove('updating');
        }
    }

    // ── Sort handlers ─────────────────────────────────────────
    function updateRelevantSort() {
        if (!currentRelevantHeadlines.length) return;
        renderHeadlines(
            currentRelevantHeadlines,
            el.relevantHeadlinesContainer,
            el.relevantHeadlineCount,
            el.relevantSortBy.value,
            el.relevantSortOrder.value
        );
    }

    function updateAllSort() {
        if (!currentAllHeadlines.length) return;
        renderHeadlines(
            currentAllHeadlines,
            el.allHeadlinesContainer,
            el.allHeadlinesCount,
            el.allSortBy.value,
            el.allSortOrder.value
        );
    }

    // ── Init ──────────────────────────────────────────────────
    function init() {
        if (el.headerVersionDisplay) el.headerVersionDisplay.textContent = `v${APP_VERSION}`;
        if (el.metricsFrontendVersion) el.metricsFrontendVersion.textContent = `v${APP_VERSION}`;
        fetchData();
        setInterval(fetchData, refreshInterval);
        setInterval(updateRefreshProgress, 100);

        el.relevantSortBy?.addEventListener('change', updateRelevantSort);
        el.relevantSortOrder?.addEventListener('change', updateRelevantSort);
        el.allSortBy?.addEventListener('change', updateAllSort);
        el.allSortOrder?.addEventListener('change', updateAllSort);

        // Chart toggle listeners
        el.toggleRaw?.addEventListener('change', () => {
            console.log('DEBUG: Toggle Raw clicked', allHeadlinesData.length);
            if (allHeadlinesData.length) renderProbabilityChart(allHeadlinesData);
        });
        el.toggleSmoothed?.addEventListener('change', () => {
            console.log('DEBUG: Toggle Smoothed clicked', allHeadlinesData.length);
            if (allHeadlinesData.length) renderProbabilityChart(allHeadlinesData);
        });
    }

    document.addEventListener('DOMContentLoaded', init);
})();
