const API_BASE_URL = (() => {
    const { protocol, hostname, port } = window.location;
    if (protocol === 'file:') return 'http://localhost:5000';
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return port === '5000' ? '' : `http://${hostname}:5000`;
    }
    return port === '5000' ? '' : window.location.origin;
})();

const GITHUB_REPO_URL = 'https://raw.githubusercontent.com/FelixKras/intelli.github.io/data';
// ─────────────────────────────────────────────────────────────
// app.js (refactored + optimized + commented)
// ─────────────────────────────────────────────────────────────

const API_BASE_URL = (() => {
    const { protocol, hostname, port } = window.location;
    if (protocol === 'file:') return 'http://localhost:5000';
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return port === '5000' ? '' : `http://${hostname}:5000`;
    }
    return port === '5000' ? '' : window.location.origin;
})();

// Data location
const GITHUB_REPO_URL = 'https://raw.githubusercontent.com/FelixKras/intelli.github.io/data';

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────
let currentRelevantHeadlines = [];
let currentAllHeadlines = [];
let probabilityChart = null;
let nextUpdateTimer = null;
let refreshInterval = 10000;
let refreshTimer = 0;

// Used to skip full DOM re-render when data hasn't changed
let lastDataKey = null;

// ─────────────────────────────────────────────────────────────
// DOM Cache (avoid repeated getElementById calls every refresh)
// ─────────────────────────────────────────────────────────────
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
    jokesContainer: document.getElementById('jokesContainer'),
    stocksContainer: document.getElementById('stocksContainer'),

    xkcdImage: document.getElementById('xkcdImage'),
    lastUpdated: document.getElementById('lastUpdated'),

    relevantSortBy: document.getElementById('relevantSortBy'),
    relevantSortOrder: document.getElementById('relevantSortOrder'),
    allSortBy: document.getElementById('allSortBy'),
    allSortOrder: document.getElementById('allSortOrder'),
};

const skeletonNodes = document.querySelectorAll('.skeleton');
const rootContainer = document.querySelector('.max-w-7xl');

// ─────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');

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

const pct = (p) => `${Math.round(p)}%`;

function getSeverity(prob) {
    if (prob >= 85) return { label: 'Critical', cls: 'bg-red-600 text-white', lg: 'text-red-500' };
    if (prob >= 70) return { label: 'High', cls: 'bg-orange-500 text-white', lg: 'text-orange-500' };
    if (prob >= 55) return { label: 'Medium', cls: 'bg-yellow-400 text-slate-900', lg: 'text-yellow-400' };
    if (prob >= 40) return { label: 'Low', cls: 'bg-slate-200 text-slate-900', lg: 'text-slate-400' };
    return { label: 'Info', cls: 'bg-slate-100 text-slate-700', lg: 'text-slate-500' };
}

// Sort helper to keep logic consistent in both headline views
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

// ─────────────────────────────────────────────────────────────
// Refresh progress bar
// ─────────────────────────────────────────────────────────────

function updateRefreshProgress() {
    if (!el.refreshProgressBar) return;
    refreshTimer += 100;
    el.refreshProgressBar.style.width = `${Math.min((refreshTimer / refreshInterval) * 100, 100)}%`;
    if (refreshTimer >= refreshInterval) refreshTimer = 0;
}

// ─────────────────────────────────────────────────────────────
// Countdown timer
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────

function updateMetrics(m) {
    if (el.runtime) el.runtime.textContent = formatDuration(m.runtime_seconds);
    if (el.articlesProcessed) el.articlesProcessed.textContent = m.articles_processed || 0;
    if (el.notificationsSent) el.notificationsSent.textContent = m.notifications_sent || 0;
    if (el.ingestRate) el.ingestRate.textContent = `${(m.ingest_rate_per_min || 0).toFixed(2)}/min`;
    if (el.articleLag) el.articleLag.textContent = m.lag_minutes != null ? `${m.lag_minutes.toFixed(1)}m` : '--';
    if (el.apiSuccessRate) el.apiSuccessRate.textContent = `${(m.api_success_rate || 0).toFixed(1)}%`;
    if (el.errors) el.errors.textContent = m.errors_encountered || 0;
    if (el.heartbeatsSent) el.heartbeatsSent.textContent = m.telegram_heartbeats_sent || 0;

    const t = m.time_until_next_update_seconds;
    if (el.nextUpdate) {
        if (t != null && t > 0) {
            el.nextUpdate.textContent = `${Math.floor(t / 60)}m ${Math.floor(t % 60)}s`;
        } else {
            el.nextUpdate.textContent = 'Soon';
        }
    }
}

// ─────────────────────────────────────────────────────────────
// Headline rendering (shared template)
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// Probability chart
// ─────────────────────────────────────────────────────────────

function renderProbabilityChart(headlines) {
    if (!el.probabilityChart) return;
    const ctx = el.probabilityChart.getContext('2d');
    if (!ctx) return;

    // Group by timestamp, keep max probability per timestamp
    const groups = {};
    for (const h of headlines) {
        if (!h.datetime_iso) continue;
        const t = h.datetime_iso.replace(' ', 'T');
        if (!groups[t] || h.probability > groups[t].prob) {
            groups[t] = { prob: h.probability, headline: h.headline };
        }
    }

    const chartData = Object.keys(groups)
        .map(t => ({ x: new Date(t), y: groups[t].prob, headline: groups[t].headline }))
        .filter(p => p.y >= 50)
        .sort((a, b) => a.x - b.x);

    if (probabilityChart) probabilityChart.destroy();

    probabilityChart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: 'Max Probability %',
                data: chartData,
                borderColor: 'rgb(52, 211, 153)',
                backgroundColor: 'rgba(52, 211, 153, 0.1)',
                borderWidth: 2,
                fill: true,
                tension: 0.2,
                pointRadius: 4,
                pointHitRadius: 10,
                pointHoverRadius: 6,
                pointBackgroundColor: 'rgb(52, 211, 153)'
            }]
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
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(15,23,42,0.95)',
                    titleColor: 'rgb(226,232,240)',
                    bodyColor: 'rgb(226,232,240)',
                    borderColor: 'rgb(52,211,153)',
                    borderWidth: 1,
                    padding: 10,
                    displayColors: false,
                    callbacks: {
                        label: ctx => `Probability: ${ctx.parsed.y}%`,
                        afterLabel: ctx => {
                            const hl = ctx.raw.headline;
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

// ─────────────────────────────────────────────────────────────
// Jokes
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// Stocks
// ─────────────────────────────────────────────────────────────

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
                <div class="text-lg font-bold text-slate-200 font-mono">$${price}</div>
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

// ─────────────────────────────────────────────────────────────
// Fetch & render
// ─────────────────────────────────────────────────────────────

async function fetchData() {
    if (rootContainer) rootContainer.classList.add('updating');
    refreshTimer = 0;

    try {
        const bust = `?v=${Date.now()}`;

        // NOTE: jokes + stocks are inside headlines.json — no extra HTTP calls
        const [metricsRes, headlinesRes] = await Promise.all([
            fetch(`${GITHUB_REPO_URL}/metrics.json${bust}`),
            fetch(`${GITHUB_REPO_URL}/headlines.json${bust}`)
        ]);

        if (!metricsRes.ok || !headlinesRes.ok) {
            throw new Error('HTTP error! Could not fetch core data files.');
        }

        const metrics = await metricsRes.json();
        const headlinesData = await headlinesRes.json();

        // Lightweight change detection (avoid JSON.stringify full payload)
        const key = [
            metrics?.last_updated || '',
            headlinesData?.last_updated || '',
            (headlinesData?.current_headlines || []).length,
            (headlinesData?.history_headlines || []).length,
            headlinesData?.overall_probability || ''
        ].join('|');

        if (key === lastDataKey) {
            return;
        }
        lastDataKey = key;

        updateStatus(true);

        // Remove skeleton placeholders once
        skeletonNodes.forEach(el => el.classList.remove('skeleton', 'h-24', 'h-7', 'h-5', 'h-20', 'w-48', 'w-full', 'w-24', 'w-3/4'));

        // ── Metrics ──
        if (metrics) {
            updateMetrics(metrics);
            if (el.analysisModel) el.analysisModel.textContent = metrics.analysis_model || '';
            if (el.jokesModel) el.jokesModel.textContent = metrics.jokes_model || '';
            if (metrics.last_updated && el.lastDataUpdate) el.lastDataUpdate.textContent = formatTimestamp(metrics.last_updated);
            if (metrics.next_update_time) startNextUpdateCountdown(metrics.next_update_time);
        }

        // ── Headlines ──
        if (headlinesData) {
            const current = headlinesData.current_headlines || [];
            const history = headlinesData.history_headlines || [];
            const all = [...current, ...history];

            // Use server time if provided, otherwise local time
            const serverTime = new Date((metrics?.last_updated || new Date().toISOString()).replace(' ', 'T'));
            const ago24h = new Date(serverTime - 86400000);
            const ago2d  = new Date(serverTime - 2 * 86400000);
            const ago5d  = new Date(serverTime - 5 * 86400000);

            // Max probability in last 24h (O(n), no sort)
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

            // Filtering rules:
            // <50% => last 2 days; >=50% => last 5 days
            const filtered = [];
            const relevant = [];
            for (const h of all) {
                const d = h.datetime_iso ? new Date(h.datetime_iso) : null;
                if (!d) continue;
                if (h.probability >= 50) {
                    if (d >= ago5d) {
                        filtered.push(h);
                        relevant.push(h);
                    }
                } else {
                    if (d >= ago2d) filtered.push(h);
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

        // ── Joke (single string in headlines.json) ──
        const jokeText = headlinesData?.joke;
        renderJokes(jokeText ? [jokeText] : []);

        // ── Stocks (array in headlines.json) ──
        renderStocks(headlinesData?.stocks || []);

        // ── XKCD ──
        // FIX: prefer embedded base64 if present; fallback to PNG URL
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

// ─────────────────────────────────────────────────────────────
// Sort handlers
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────

function init() {
    fetchData();
    setInterval(fetchData, refreshInterval);
    setInterval(updateRefreshProgress, 100);

    el.relevantSortBy?.addEventListener('change', updateRelevantSort);
    el.relevantSortOrder?.addEventListener('change', updateRelevantSort);
    el.allSortBy?.addEventListener('change', updateAllSort);
    el.allSortOrder?.addEventListener('change', updateAllSort);
}

document.addEventListener('DOMContentLoaded', init);
// State
let currentRelevantHeadlines = [];
let currentAllHeadlines = [];
let probabilityChart = null;
let nextUpdateTimer = null;
let refreshInterval = 10000;
let refreshTimer = 0;
let lastDataHash = null;

// ── Utility ──────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

function pad2(n) { return String(n).padStart(2, '0'); }

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

function pct(p) { return `${Math.round(p)}%`; }

function getSeverity(prob) {
    if (prob >= 85) return { label: 'Critical', cls: 'bg-red-600 text-white', lg: 'text-red-500' };
    if (prob >= 70) return { label: 'High', cls: 'bg-orange-500 text-white', lg: 'text-orange-500' };
    if (prob >= 55) return { label: 'Medium', cls: 'bg-yellow-400 text-slate-900', lg: 'text-yellow-400' };
    if (prob >= 40) return { label: 'Low', cls: 'bg-slate-200 text-slate-900', lg: 'text-slate-400' };
    return { label: 'Info', cls: 'bg-slate-100 text-slate-700', lg: 'text-slate-500' };
}

function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
}

function setClass(id, className) {
    const el = $(id);
    if (el) el.className = className;
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

// ── Refresh progress bar ─────────────────────────────────────────────

function updateRefreshProgress() {
    const bar = $('refreshProgressBar');
    if (!bar) return;
    refreshTimer += 100;
    bar.style.width = `${Math.min((refreshTimer / refreshInterval) * 100, 100)}%`;
    if (refreshTimer >= refreshInterval) refreshTimer = 0;
}

// ── Countdown ────────────────────────────────────────────────────────

function startNextUpdateCountdown(nextIso) {
    if (nextUpdateTimer) clearInterval(nextUpdateTimer);
    if (!nextIso) return;

    const target = new Date(nextIso.replace(' ', 'T')).getTime();

    nextUpdateTimer = setInterval(() => {
        const diff = target - Date.now();
        if (diff < 0) {
            setText('nextUpdate', 'Soon');
            clearInterval(nextUpdateTimer);
        } else {
            const m = Math.floor((diff % 3600000) / 60000);
            const s = Math.floor((diff % 60000) / 1000);
            setText('nextUpdate', `${m}m ${s}s`);
        }
    }, 1000);
}

// ── Status ───────────────────────────────────────────────────────────

function updateStatus(online) {
    const color = online ? 'emerald' : 'red';
    const label = online ? 'Online' : 'Offline';
    const livenessLabel = online ? 'Online' : 'Error';

    setText('statusText', label);
    setClass('statusText', `text-${color}-300`);
    setClass('statusBadge', `text-xs px-2 py-1 rounded-md bg-slate-900 border border-slate-800 text-${color}-300`);

    const liveness = $('liveness');
    if (liveness) {
        liveness.textContent = livenessLabel;
        liveness.className = `mt-1 text-2xl font-bold text-${color}-300`;
    }
}

// ── Metrics ──────────────────────────────────────────────────────────

function updateMetrics(m) {
    setText('runtime', formatDuration(m.runtime_seconds));
    setText('articlesProcessed', m.articles_processed || 0);
    setText('notificationsSent', m.notifications_sent || 0);
    setText('ingestRate', `${(m.ingest_rate_per_min || 0).toFixed(2)}/min`);
    setText('articleLag', m.lag_minutes != null ? `${m.lag_minutes.toFixed(1)}m` : '--');
    setText('apiSuccessRate', `${(m.api_success_rate || 0).toFixed(1)}%`);
    setText('errors', m.errors_encountered || 0);
    setText('heartbeatsSent', m.telegram_heartbeats_sent || 0);

    const t = m.time_until_next_update_seconds;
    if (t != null && t > 0) {
        setText('nextUpdate', `${Math.floor(t / 60)}m ${Math.floor(t % 60)}s`);
    } else {
        setText('nextUpdate', 'Soon');
    }
}

// ── Headline card (shared template) ─────────────────────────────────

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

// ── Render headlines (unified) ───────────────────────────────────────

function renderHeadlines(headlines, containerId, countId, sortBy = 'date', sortOrder = 'desc') {
    const container = $(containerId);
    const countEl = $(countId);

    if (!headlines || !headlines.length) {
        container.innerHTML = '<div class="text-center py-6 text-slate-400">No headlines available</div>';
        if (countEl) countEl.textContent = '0 headlines';
        return;
    }

    const sorted = sortHeadlines(headlines, sortBy, sortOrder);
    if (countEl) countEl.textContent = `${sorted.length} headlines`;
    container.innerHTML = sorted.map(headlineCard).join('');
}

// ── Probability chart ────────────────────────────────────────────────

function renderProbabilityChart(headlines) {
    const ctx = $('probabilityChart')?.getContext('2d');
    if (!ctx) return;

    const groups = {};
    for (const h of headlines) {
        if (!h.datetime_iso) continue;
        const t = h.datetime_iso.replace(' ', 'T');
        if (!groups[t] || h.probability > groups[t].prob) {
            groups[t] = { prob: h.probability, headline: h.headline };
        }
    }

    const chartData = Object.keys(groups)
        .map(t => ({ x: new Date(t), y: groups[t].prob, headline: groups[t].headline }))
        .filter(p => p.y >= 50)
        .sort((a, b) => a.x - b.x);

    if (probabilityChart) probabilityChart.destroy();

    probabilityChart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: 'Max Probability %',
                data: chartData,
                borderColor: 'rgb(52, 211, 153)',
                backgroundColor: 'rgba(52, 211, 153, 0.1)',
                borderWidth: 2,
                fill: true,
                tension: 0.2,
                pointRadius: 4,
                pointHitRadius: 10,
                pointHoverRadius: 6,
                pointBackgroundColor: 'rgb(52, 211, 153)'
            }]
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
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(15,23,42,0.95)',
                    titleColor: 'rgb(226,232,240)',
                    bodyColor: 'rgb(226,232,240)',
                    borderColor: 'rgb(52,211,153)',
                    borderWidth: 1,
                    padding: 10,
                    displayColors: false,
                    callbacks: {
                        label: ctx => `Probability: ${ctx.parsed.y}%`,
                        afterLabel: ctx => {
                            const hl = ctx.raw.headline;
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

// ── Jokes ────────────────────────────────────────────────────────────

function renderJokes(jokes) {
    const container = $('jokesContainer');
    if (!container) return;

    if (!jokes || !jokes.length) {
        container.innerHTML = '<div class="text-slate-400 text-sm">No jokes generated yet.</div>';
        return;
    }

    container.innerHTML = jokes.slice(0, 5).map(joke => {
        const text = (typeof joke === 'object' && joke !== null && 'joke' in joke) ? joke.joke : joke;
        return `<div class="rounded-lg bg-slate-950/40 border border-slate-800 p-3 text-sm text-slate-200">${text}</div>`;
    }).join('');
}

// ── Stocks ───────────────────────────────────────────────────────────

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
                <div class="text-lg font-bold text-slate-200 font-mono">$${price}</div>
                <div class="text-xs font-semibold text-${color}-400">${arrow} ${Math.abs(chg).toFixed(2)}%</div>
            </div>
        </div>
    </div>`;
}

function renderStocks(stocks) {
    const container = $('stocksContainer');
    if (!container) return;

    if (!stocks || !stocks.length) {
        container.innerHTML = '<div class="text-slate-400 text-sm py-4 text-center">Market closed or data unavailable</div>';
        return;
    }

    container.innerHTML = stocks.map(stockCard).join('');
}

// ── Fetch & render ───────────────────────────────────────────────────

async function fetchData() {
    const container = document.querySelector('.max-w-7xl');
    if (container) container.classList.add('updating');
    refreshTimer = 0;

    try {
        const bust = `?v=${Date.now()}`;

        const [metricsRes, headlinesRes] = await Promise.all([
            fetch(`${GITHUB_REPO_URL}/metrics.json${bust}`),
            fetch(`${GITHUB_REPO_URL}/headlines.json${bust}`)
        ]);

        if (!metricsRes.ok || !headlinesRes.ok) {
            throw new Error('HTTP error! Could not fetch core data files.');
        }

        const metrics = await metricsRes.json();
        const headlinesData = await headlinesRes.json();

        // Quick hash check — skip DOM rebuild if nothing changed
        const hash = JSON.stringify({ lu: metrics.last_updated, op: headlinesData.overall_probability });
        if (hash === lastDataHash) {
            if (container) container.classList.remove('updating');
            return;
        }
        lastDataHash = hash;

        updateStatus(true);

        // Strip skeleton classes
        $$('.skeleton').forEach(el => el.classList.remove('skeleton', 'h-24', 'h-7', 'h-5', 'h-20', 'w-48', 'w-full', 'w-24', 'w-3/4'));

        // ── Metrics ──
        if (metrics) {
            updateMetrics(metrics);
            setText('analysisModel', metrics.analysis_model || '');
            setText('jokesModel', metrics.jokes_model || '');
            if (metrics.last_updated) setText('lastDataUpdate', formatTimestamp(metrics.last_updated));
            if (metrics.next_update_time) startNextUpdateCountdown(metrics.next_update_time);
        }

        // ── Headlines ──
        if (headlinesData) {
            const current = headlinesData.current_headlines || [];
            const history = headlinesData.history_headlines || [];
            const all = [...current, ...history];

            const serverTime = new Date((metrics?.last_updated || new Date().toISOString()).replace(' ', 'T'));
            const ago24h = new Date(serverTime - 86400000);
            const ago2d  = new Date(serverTime - 2 * 86400000);
            const ago5d  = new Date(serverTime - 5 * 86400000);

            // Max probability in last 24h
            const last24h = all.filter(h => {
                const d = h.datetime_iso ? new Date(h.datetime_iso) : null;
                return d && d >= ago24h;
            });

            if (last24h.length) {
                const top = last24h.reduce((a, b) => b.probability > a.probability ? b : a);
                const sev = getSeverity(top.probability);

                setText('maxProbability', pct(top.probability));
                setClass('maxProbability', `mt-3 text-9xl font-black tracking-tight ${sev.lg}`);
                setText('maxProbSource', `${top.source || '—'} (${top.source_type || 'Unknown'})`);
                setText('maxProbValue', `${top.probability}%`);
                setText('maxProbHeadline', top.headline);
                setText('maxProbTime', formatTimestamp(top.datetime_iso));
                setText('severityBadge', sev.label);
                setClass('severityBadge', `text-sm px-3 py-1.5 rounded-md ${sev.cls}`);
            } else {
                setText('maxProbability', '--');
                setText('maxProbSource', '—');
                setText('maxProbValue', '—');
                setText('maxProbHeadline', 'No headlines in the last 24 hours.');
                setText('maxProbTime', '—');
                setText('severityBadge', 'Info');
                setClass('severityBadge', 'text-sm px-3 py-1.5 rounded-md bg-slate-200 text-slate-900');
            }

            // Filtered: <50% → 2 days, ≥50% → 5 days
            const filtered = all.filter(h => {
                const d = h.datetime_iso ? new Date(h.datetime_iso) : null;
                if (!d) return false;
                return h.probability >= 50 ? d >= ago5d : d >= ago2d;
            });

            // Relevant: ≥50% in last 5 days
            const relevant = all.filter(h => {
                const d = h.datetime_iso ? new Date(h.datetime_iso) : null;
                return h.probability >= 50 && d && d >= ago5d;
            });

            currentRelevantHeadlines = relevant;
            currentAllHeadlines = filtered;

            const rSortBy    = $('relevantSortBy')?.value || 'date';
            const rSortOrder = $('relevantSortOrder')?.value || 'desc';
            const aSortBy    = $('allSortBy')?.value || 'date';
            const aSortOrder = $('allSortOrder')?.value || 'desc';

            renderHeadlines(relevant, 'relevantHeadlinesContainer', 'relevantHeadlineCount', rSortBy, rSortOrder);
            renderHeadlines(filtered, 'allHeadlinesContainer', 'allHeadlinesCount', aSortBy, aSortOrder);
            renderProbabilityChart([...history, ...current]);
        }

        // ── Joke (single string from headlines.json) ──
        const jokeText = headlinesData.joke;
        renderJokes(jokeText ? [jokeText] : []);

        // ── Stocks (array from headlines.json) ──
        renderStocks(headlinesData.stocks || []);

        // ── XKCD ──
        const xkcd = $('xkcdImage');
        if (xkcd) xkcd.src = `${GITHUB_REPO_URL}/xkcd_comic.png?v=${Date.now()}`;

        setText('lastUpdated', new Date().toLocaleTimeString());

    } catch (err) {
        console.error('Error fetching data:', err);
        updateStatus(false);
    } finally {
        if (container) container.classList.remove('updating');
    }
}

// ── Sort handlers ────────────────────────────────────────────────────

function updateRelevantSort() {
    if (!currentRelevantHeadlines.length) return;
    renderHeadlines(currentRelevantHeadlines, 'relevantHeadlinesContainer', 'relevantHeadlineCount',
        $('relevantSortBy').value, $('relevantSortOrder').value);
}

function updateAllSort() {
    if (!currentAllHeadlines.length) return;
    renderHeadlines(currentAllHeadlines, 'allHeadlinesContainer', 'allHeadlinesCount',
        $('allSortBy').value, $('allSortOrder').value);
}

// ── Init ─────────────────────────────────────────────────────────────

function init() {
    fetchData();
    setInterval(fetchData, refreshInterval);
    setInterval(updateRefreshProgress, 100);

    $('relevantSortBy')?.addEventListener('change', updateRelevantSort);
    $('relevantSortOrder')?.addEventListener('change', updateRelevantSort);
    $('allSortBy')?.addEventListener('change', updateAllSort);
    $('allSortOrder')?.addEventListener('change', updateAllSort);
}

document.addEventListener('DOMContentLoaded', init);
