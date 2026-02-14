const API_BASE_URL = (() => {
    const proto = window.location.protocol;
    const host = window.location.hostname;
    const port = window.location.port;
    if (proto === 'file:') return 'http://localhost:5000';
    if (host === 'localhost' || host === '127.0.0.1') {
        return port === '5000' ? '' : `http://${host}:5000`;
    }
    return port === '5000' ? '' : window.location.origin;
})();

// Store current headlines data for re-sorting
let currentRelevantHeadlines = [];
let currentAllHeadlines = [];
let probabilityChart = null;
let nextUpdateTimer = null;
let refreshInterval = 10000;
let refreshTimer = 0;

function updateRefreshProgress() {
    const progressBar = document.getElementById('refreshProgressBar');
    if (!progressBar) return;
    
    refreshTimer += 100;
    const progress = (refreshTimer / refreshInterval) * 100;
    progressBar.style.width = `${Math.min(progress, 100)}%`;
    
    if (refreshTimer >= refreshInterval) {
        refreshTimer = 0;
    }
}

function formatDuration(seconds) {
    if (seconds < 0) return "00:00:00";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function startNextUpdateCountdown(nextUpdateTimeIso) {
    if (nextUpdateTimer) clearInterval(nextUpdateTimer);
    if (!nextUpdateTimeIso) return;

    const nextUpdate = new Date(nextUpdateTimeIso.replace(' ', 'T')).getTime();
    
    nextUpdateTimer = setInterval(() => {
        const now = new Date().getTime();
        const distance = nextUpdate - now;
        
        if (distance < 0) {
            document.getElementById('nextUpdate').textContent = 'Soon';
            clearInterval(nextUpdateTimer);
        } else {
            const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((distance % (1000 * 60)) / 1000);
            document.getElementById('nextUpdate').textContent = `${minutes}m ${seconds}s`;
        }
    }, 1000);
}

function formatTimestamp(isoString) {
    if (!isoString) return 'N/A';
    const date = new Date(isoString.replace(' ', 'T')); // Handle both space and T
    if (isNaN(date.getTime())) return isoString; // Fallback to raw string if invalid

    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${day}/${month}/${year}, ${hours}:${minutes}:${seconds}`;
}

function pct(probability) {
    return `${Math.round(probability)}%`; // Assuming probability is already 0-100
}

function getSeverityFromProb(probability) { // Probability here is 0-100, not 0-1
    if (probability >= 85) return { label: 'Critical', class: 'bg-red-600 text-white', largeTextClass: 'text-red-500' };
    if (probability >= 70) return { label: 'High', class: 'bg-orange-500 text-white', largeTextClass: 'text-orange-500' };
    if (probability >= 55) return { label: 'Medium', class: 'bg-yellow-400 text-slate-900', largeTextClass: 'text-yellow-400' };
    if (probability >= 40) return { label: 'Low', class: 'bg-slate-200 text-slate-900', largeTextClass: 'text-slate-400' };
    return { label: 'Info', class: 'bg-slate-100 text-slate-700', largeTextClass: 'text-slate-500' };
}

function updateStatus(isOnline) {
    const statusText = document.getElementById('statusText');
    const statusBadge = document.getElementById('statusBadge');
    const liveness = document.getElementById('liveness');
    
    if (isOnline) {
        statusText.textContent = 'Online';
        statusText.className = 'text-emerald-300';
        statusBadge.className = 'text-xs px-2 py-1 rounded-md bg-slate-900 border border-slate-800 text-emerald-300';
        if (liveness) liveness.textContent = 'Online';
        if (liveness) liveness.className = 'mt-1 text-2xl font-bold text-emerald-300';
    } else {
        statusText.textContent = 'Offline';
        statusText.className = 'text-red-300';
        statusBadge.className = 'text-xs px-2 py-1 rounded-md bg-slate-900 border border-slate-800 text-red-300';
        if (liveness) liveness.textContent = 'Error';
        if (liveness) liveness.className = 'mt-1 text-2xl font-bold text-red-300';
    }
}

function updateMetrics(metrics) {
    document.getElementById('runtime').textContent = formatDuration(metrics.runtime_seconds);
    document.getElementById('articlesProcessed').textContent = metrics.articles_processed || 0;
    document.getElementById('notificationsSent').textContent = metrics.notifications_sent || 0;

    const ingestRate = metrics.ingest_rate_per_min || 0;
    document.getElementById('ingestRate').textContent = `${ingestRate.toFixed(2)}/min`;

    const lagMinutes = metrics.lag_minutes;
    if (lagMinutes !== null && lagMinutes !== undefined) {
        document.getElementById('articleLag').textContent = `${lagMinutes.toFixed(1)}m`;
    } else {
        document.getElementById('articleLag').textContent = '--';
    }

    const apiSuccessRate = metrics.api_success_rate || 0;
    document.getElementById('apiSuccessRate').textContent = `${apiSuccessRate.toFixed(1)}%`;

    document.getElementById('errors').textContent = metrics.errors_encountered || 0;

    document.getElementById('heartbeatsSent').textContent = metrics.telegram_heartbeats_sent || 0;

    const timeUntilUpdate = metrics.time_until_next_update_seconds;
    if (timeUntilUpdate !== null && timeUntilUpdate !== undefined && timeUntilUpdate > 0) {
        const minutes = Math.floor(timeUntilUpdate / 60);
        const seconds = Math.floor(timeUntilUpdate % 60);
        document.getElementById('nextUpdate').textContent = `${minutes}m ${seconds}s`;
    } else {
        document.getElementById('nextUpdate').textContent = 'Soon';
    }
}

function renderRelevantHeadlines(headlines, sortBy = 'date', sortOrder = 'desc') {
    const container = document.getElementById('relevantHeadlinesContainer');
    const countEl = document.getElementById('relevantHeadlineCount');

    if (!headlines || headlines.length === 0) {
        container.innerHTML = '<div class="text-center py-6 text-slate-400">No relevant headlines available</div>';
        countEl.textContent = '0 headlines';
        return;
    }

    const sortedHeadlines = [...headlines].sort((a, b) => {
        if (sortBy === 'probability') {
            return sortOrder === 'desc' ? b.probability - a.probability : a.probability - b.probability;
        } else {
            const dateA = a.datetime_iso ? new Date(a.datetime_iso) : new Date(0);
            const dateB = b.datetime_iso ? new Date(b.datetime_iso) : new Date(0);
            return sortOrder === 'desc' ? dateB - dateA : dateA - dateB;
        }
    });

    countEl.textContent = `${sortedHeadlines.length} headlines`;

    const headlineCards = sortedHeadlines.map(headline => {
        const prob = headline.probability;
        const sev = getSeverityFromProb(prob);
        const sourceType = headline.source_type || 'Unknown';

        const timeStr = headline.datetime_iso ? formatTimestamp(headline.datetime_iso) : 'N/A';

        return `
            <div class="headline-card fade-in">
                <div class="flex items-start justify-between gap-3">
                    <div class="flex-1">
                        <div class="text-sm font-medium text-slate-200">${headline.headline}</div>
                        <div class="mt-1 text-xs text-slate-400">Keywords: ${headline.keywords || 'N/A'}</div>
                    </div>
                    <span class="text-xs px-2 py-1 rounded-md ${sev.class}">${headline.probability}%</span>
                </div>
                <div class="mt-2 flex items-center gap-2">
                    <span class="text-xs text-slate-500">Source:</span>
                    <span class="text-xs font-semibold text-slate-300">${headline.source}</span>
                    <span class="text-xs text-slate-500">•</span>
                    <span class="text-xs text-slate-400">${sourceType}</span>
                    <span class="text-xs text-slate-500">•</span>
                    <span class="text-xs text-slate-400">${timeStr}</span>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = headlineCards;
}

function renderAllHeadlines(headlines, sortBy = 'date', sortOrder = 'desc') {
    const container = document.getElementById('allHeadlinesContainer');
    const countEl = document.getElementById('allHeadlinesCount');

    if (!headlines || headlines.length === 0) {
        container.innerHTML = '<div class="text-center py-6 text-slate-400">No headlines available</div>';
        countEl.textContent = '0 headlines';
        return;
    }

    const sortedHeadlines = [...headlines].sort((a, b) => {
        if (sortBy === 'probability') {
            return sortOrder === 'desc' ? b.probability - a.probability : a.probability - b.probability;
        } else {
            const dateA = a.datetime_iso ? new Date(a.datetime_iso) : new Date(0);
            const dateB = b.datetime_iso ? new Date(b.datetime_iso) : new Date(0);
            return sortOrder === 'desc' ? dateB - dateA : dateA - dateB;
        }
    });

    countEl.textContent = `${sortedHeadlines.length} headlines`;

    const headlineCards = sortedHeadlines.map(headline => {
        const prob = headline.probability;
        const sev = getSeverityFromProb(prob);
        const sourceType = headline.source_type || 'Unknown';

        const timeStr = headline.datetime_iso ? formatTimestamp(headline.datetime_iso) : 'N/A';

        return `
            <div class="headline-card fade-in">
                <div class="flex items-start justify-between gap-3">
                    <div class="flex-1">
                        <div class="text-sm font-medium text-slate-200">${headline.headline}</div>
                        <div class="mt-1 text-xs text-slate-400">Keywords: ${headline.keywords || 'N/A'}</div>
                    </div>
                    <span class="text-xs px-2 py-1 rounded-md ${sev.class}">${headline.probability}%</span>
                </div>
                <div class="mt-2 flex items-center gap-2">
                    <span class="text-xs text-slate-500">Source:</span>
                    <span class="text-xs font-semibold text-slate-300">${headline.source}</span>
                    <span class="text-xs text-slate-500">•</span>
                    <span class="text-xs text-slate-400">${sourceType}</span>
                    <span class="text-xs text-slate-500">•</span>
                    <span class="text-xs text-slate-400">${timeStr}</span>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = headlineCards;
}

function renderProbabilityChart(headlines) {
    const ctx = document.getElementById('probabilityChart').getContext('2d');
    
    // Group headlines by run/timestamp and find max probability for each
    const runGroups = {};
    headlines.forEach(h => {
        if (h.datetime_iso) {
            // Normalize timestamp to avoid string sort issues (handle ' ' vs 'T')
            const time = h.datetime_iso.replace(' ', 'T');
            if (!runGroups[time] || h.probability > runGroups[time].prob) {
                runGroups[time] = {
                    prob: h.probability,
                    headline: h.headline
                };
            }
        }
    });

    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
    
    // Sort timestamps chronologically before mapping to chart points
    const chartData = Object.keys(runGroups)
        .map(t => ({
            x: new Date(t),
            y: runGroups[t].prob,
            headline: runGroups[t].headline
        }))
        .filter(point => point.y >= 50)
        .sort((a, b) => a.x - b.x);

    if (probabilityChart) {
        probabilityChart.destroy();
    }

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
            interaction: {
                intersect: false,
                mode: 'index',
            },
            scales: {
                x: {
                    type: 'time',
                    time: {
                        unit: 'day',
                        displayFormats: {
                            day: 'MMM d'
                        }
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)'
                    },
                    ticks: {
                        color: 'rgba(255, 255, 255, 0.5)',
                        font: { size: 10 }
                    }
                },
                y: {
                    beginAtZero: true,
                    max: 100,
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)'
                    },
                    ticks: {
                        color: 'rgba(255, 255, 255, 0.5)',
                        font: { size: 10 },
                        callback: (val) => val + '%'
                    }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(15, 23, 42, 0.95)',
                    titleColor: 'rgb(226, 232, 240)',
                    bodyColor: 'rgb(226, 232, 240)',
                    borderColor: 'rgb(52, 211, 153)',
                    borderWidth: 1,
                    padding: 10,
                    displayColors: false,
                    callbacks: {
                        label: (context) => `Probability: ${context.parsed.y}%`,
                        afterLabel: (context) => {
                            const headline = context.raw.headline;
                            if (headline) {
                                // Wrap text for tooltip if too long
                                const words = headline.split(' ');
                                let lines = [''];
                                let currentLine = 0;
                                words.forEach(word => {
                                    if ((lines[currentLine] + word).length > 40) {
                                        currentLine++;
                                        lines[currentLine] = '';
                                    }
                                    lines[currentLine] += word + ' ';
                                });
                                return ['', 'Headline:', ...lines];
                            }
                            return '';
                        }
                    }
                }
            }
        }
    });
}

function renderJokes(jokes) {
    const container = document.getElementById('jokesContainer');

    if (!jokes || jokes.length === 0) {
        container.innerHTML = '<div class="text-slate-400 text-sm">No jokes generated yet.</div>';
        return;
    }

    const jokeItems = jokes.slice(0, 5).map(joke => {
        // Assuming joke object is { joke: "joke text", timestamp: "..." }
        const jokeText = typeof joke === 'object' && joke !== null && 'joke' in joke ? joke.joke : joke;
        return `
            <div class="rounded-lg bg-slate-950/40 border border-slate-800 p-3 text-sm text-slate-200">
                ${jokeText}
            </div>
        `;
    }).join('');

    container.innerHTML = jokeItems;
}

function renderStocks(stocks) {
    const container = document.getElementById('stocksContainer');
    console.log('Rendering stocks:', stocks);

    if (!stocks || stocks.length === 0) {
        container.innerHTML = '<div class="text-slate-400 text-sm py-4 text-center">Market closed or data unavailable</div>';
        return;
    }

    const stockItems = stocks.map(stock => {
        const ticker = stock.ticker || 'N/A';
        const metadata = stock.metadata || {};
        const marketState = metadata.market_state || 'UNKNOWN';
        const expectedTrend = metadata.expected_trend || 'NEUTRAL';
        const price = metadata.price ? metadata.price.toFixed(2) : 'N/A';
        const changePercent = metadata.change_percent || 0;

        const isPositive = changePercent >= 0;
        const colorClass = isPositive ? 'text-emerald-400' : 'text-red-400';
        const bgClass = isPositive ? 'bg-emerald-950/20' : 'bg-red-950/20';
        const borderClass = isPositive ? 'border-emerald-900/30' : 'border-red-900/30';
        const arrowIcon = isPositive ? '↑' : '↓';

        let trendColor = 'text-slate-400';
        if (expectedTrend === 'UP') trendColor = 'text-emerald-400';
        if (expectedTrend === 'DOWN') trendColor = 'text-red-400';

        let stateBadgeClass = 'bg-slate-800 text-slate-400';
        if (marketState === 'REGULAR') stateBadgeClass = 'bg-blue-900/40 text-blue-400 border border-blue-800/50';
        if (marketState === 'PRE' || marketState === 'POST') stateBadgeClass = 'bg-amber-900/40 text-amber-400 border border-amber-800/50';

        return `
            <div class="rounded-lg bg-slate-950/50 border ${borderClass} p-3 hover:bg-slate-950/70 transition-colors">
                <div class="flex items-start justify-between gap-2">
                    <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2">
                            <span class="text-sm font-bold text-slate-100 font-mono">${ticker}</span>
                            <span class="text-[10px] px-1.5 py-0.5 rounded ${stateBadgeClass} font-medium uppercase">
                                ${marketState}
                            </span>
                        </div>
                        <div class="mt-1 flex items-center gap-2">
                            <span class="text-[10px] text-slate-500 uppercase">Trend:</span>
                            <span class="text-[10px] font-bold ${trendColor}">${expectedTrend}</span>
                        </div>
                    </div>
                    <div class="text-right">
                        <div class="text-lg font-bold text-slate-200 font-mono">$${price}</div>
                        <div class="text-xs font-semibold ${colorClass}">
                            ${arrowIcon} ${Math.abs(changePercent).toFixed(2)}%
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = stockItems;
}

async function fetchData() {
    console.log('Fetching data files from GitHub...');
    const GITHUB_REPO_URL = 'https://raw.githubusercontent.com/FelixKras/intelli.github.io/data';
    
    // Visual feedback for refresh
    const container = document.querySelector('.max-w-7xl');
    if (container) container.classList.add('updating');
    refreshTimer = 0; // Reset timer on fetch start

    try {
        const cacheBust = `?v=${new Date().getTime()}`;
        
        const [metricsRes, headlinesRes, jokesRes, stocksRes] = await Promise.all([
            fetch(`${GITHUB_REPO_URL}/metrics.json${cacheBust}`),
            fetch(`${GITHUB_REPO_URL}/headlines.json${cacheBust}`),
            fetch(`${GITHUB_REPO_URL}/jokes.json${cacheBust}`),
            fetch(`${GITHUB_REPO_URL}/stocks.json${cacheBust}`)
        ]);

        if (!metricsRes.ok || !headlinesRes.ok) {
            throw new Error(`HTTP error! Could not fetch core data files.`);
        }

        const metrics = await metricsRes.json();
        const headlinesData = await headlinesRes.json();
        const jokes = jokesRes.ok ? await jokesRes.json() : { jokes: [] };
        const stocks = stocksRes.ok ? await stocksRes.json() : { stocks: [] };

        const serverTimeStr = metrics && metrics.last_updated ? metrics.last_updated : new Date().toISOString();
        const now = new Date(serverTimeStr.replace(' ', 'T'));
        const twentyFourHoursAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000));
        const twoDaysAgo = new Date(now.getTime() - (2 * 24 * 60 * 60 * 1000));
        const fiveDaysAgo = new Date(now.getTime() - (5 * 24 * 60 * 60 * 1000));

        updateStatus(true);
        
        // Remove skeleton classes
        document.querySelectorAll('.skeleton').forEach(el => el.classList.remove('skeleton', 'h-24', 'h-7', 'h-5', 'h-20', 'w-48', 'w-full', 'w-24', 'w-3/4'));

        if (metrics) {
            updateMetrics(metrics);
            if (metrics.analysis_model) {
                document.getElementById('analysisModel').textContent = metrics.analysis_model;
            }
            if (metrics.jokes_model) {
                document.getElementById('jokesModel').textContent = metrics.jokes_model;
            }
            if (metrics.last_updated) {
                document.getElementById('lastDataUpdate').textContent = formatTimestamp(metrics.last_updated);
            }
            if (metrics.next_update_time) {
                startNextUpdateCountdown(metrics.next_update_time);
            }
        }

        if (headlinesData) {
            const allHistory = headlinesData.history_headlines || [];
            const currentRun = headlinesData.current_headlines || [];
            
            // Combine all available headlines for filtering
            const allHeadlines = [...currentRun, ...allHistory];
            
            // 1. Derive main probability score from last 24 hrs
            const last24hHeadlines = allHeadlines.filter(h => {
                const date = h.datetime_iso ? new Date(h.datetime_iso) : null;
                return date && date >= twentyFourHoursAgo;
            });

            if (last24hHeadlines.length > 0) {
                const sorted24h = [...last24hHeadlines].sort((a, b) => b.probability - a.probability);
                const maxHeadline = sorted24h[0];
                const maxProb = maxHeadline.probability;
                const severity = getSeverityFromProb(maxProb);
                const maxSourceType = maxHeadline.source_type || 'Unknown';

                document.getElementById('maxProbability').textContent = pct(maxProb);
                document.getElementById('maxProbability').className = `mt-3 text-9xl font-black tracking-tight ${severity.largeTextClass}`;
                document.getElementById('maxProbSource').textContent = `${maxHeadline.source || '—'} (${maxSourceType})`;
                document.getElementById('maxProbValue').textContent = `${maxHeadline.probability}%`;
                document.getElementById('maxProbHeadline').textContent = maxHeadline.headline;
                document.getElementById('maxProbTime').textContent = formatTimestamp(maxHeadline.datetime_iso);
                document.getElementById('severityBadge').textContent = severity.label;
                document.getElementById('severityBadge').className = `text-sm px-3 py-1.5 rounded-md ${severity.class}`;
            } else {
                document.getElementById('maxProbability').textContent = '--';
                document.getElementById('maxProbSource').textContent = '—';
                document.getElementById('maxProbValue').textContent = '—';
                document.getElementById('maxProbHeadline').textContent = 'No headlines in the last 24 hours.';
                document.getElementById('maxProbTime').textContent = '—';
                document.getElementById('severityBadge').textContent = 'Info';
                document.getElementById('severityBadge').className = 'text-sm px-3 py-1.5 rounded-md bg-slate-200 text-slate-900';
            }

            // 4. Filtering rules:
            // < 50% probability: max 2 days
            // >= 50% probability: max 5 days
            const filteredAllHeadlines = allHeadlines.filter(h => {
                const date = h.datetime_iso ? new Date(h.datetime_iso) : null;
                if (!date) return false;
                if (h.probability >= 50) {
                    return date >= fiveDaysAgo;
                } else {
                    return date >= twoDaysAgo;
                }
            });

            // 5. Top Relevant: > 50% of the past 5 days
            const relevantHeadlines = allHeadlines.filter(h => {
                const date = h.datetime_iso ? new Date(h.datetime_iso) : null;
                return h.probability >= 50 && date && date >= fiveDaysAgo;
            });

            currentRelevantHeadlines = relevantHeadlines;
            currentAllHeadlines = filteredAllHeadlines;

            const relevantSortBy = document.getElementById('relevantSortBy')?.value || 'date';
            const relevantSortOrder = document.getElementById('relevantSortOrder')?.value || 'desc';
            const allSortBy = document.getElementById('allSortBy')?.value || 'date';
            const allSortOrder = document.getElementById('allSortOrder')?.value || 'desc';

            renderRelevantHeadlines(relevantHeadlines, relevantSortBy, relevantSortOrder);
            renderAllHeadlines(filteredAllHeadlines, allSortBy, allSortOrder);
            
            // 9. Render probability graph
            renderProbabilityChart(allHistory.concat(currentRun));
        }

        if (jokes.jokes) {
            renderJokes(jokes.jokes);
        }

        if (stocks.stocks) {
            renderStocks(stocks.stocks);
        }

        // Update XKCD comic image with cache buster
        const xkcdImage = document.getElementById('xkcdImage');
        if (xkcdImage) {
            xkcdImage.src = `${GITHUB_REPO_URL}/xkcd_comic.png?v=${cacheBust}`;
        }

        document.getElementById('lastUpdated').textContent = new Date().toLocaleTimeString();
        if (container) container.classList.remove('updating');

    } catch (error) {
        console.error('Error fetching data:', error);
        updateStatus(false);
        if (container) container.classList.remove('updating');
    }
}

function updateRelevantSort() {
    const sortBy = document.getElementById('relevantSortBy').value;
    const sortOrder = document.getElementById('relevantSortOrder').value;
    if (currentRelevantHeadlines.length > 0) {
        renderRelevantHeadlines(currentRelevantHeadlines, sortBy, sortOrder);
    }
}

function updateAllSort() {
    const sortBy = document.getElementById('allSortBy').value;
    const sortOrder = document.getElementById('allSortOrder').value;
    if (currentAllHeadlines.length > 0) {
        renderAllHeadlines(currentAllHeadlines, sortBy, sortOrder);
    }
}

function startAutoRefresh(intervalMs = 10000) {
    refreshInterval = intervalMs;
    setInterval(fetchData, intervalMs);
    setInterval(updateRefreshProgress, 100);
}

function init() {
    fetchData();
    startAutoRefresh(10000);

    // Add event listeners for sort controls
    document.getElementById('relevantSortBy').addEventListener('change', updateRelevantSort);
    document.getElementById('relevantSortOrder').addEventListener('change', updateRelevantSort);
    document.getElementById('allSortBy').addEventListener('change', updateAllSort);
    document.getElementById('allSortOrder').addEventListener('change', updateAllSort);
}

document.addEventListener('DOMContentLoaded', init);