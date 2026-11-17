// content.js - Cortana V2.10 (性能优化：引入防抖机制)
(function() {
    'use strict';
    
    if (window.hasCortanaRun) return;
    window.hasCortanaRun = true;

    console.log("Cortana V2.10: 高性能引擎启动");
    
    const API_PY_STORE = "https://steampy.com/xboot/common/plugIn/getGame";
    const API_PY_SEARCH = "https://steampy.com/xboot/usSteamGame/saleKeyByName";
    const API_STEAM_DETAILS = "https://store.steampowered.com/api/appdetails";

    // =========================================================
    //  请求代理
    // =========================================================
    function proxyRequest(url, callback) {
        chrome.runtime.sendMessage({ action: 'fetchPrice', url: url }, (response) => {
            if (response && response.success) {
                callback(response.data);
            } else {
                callback(null);
            }
        });
    }

    // =========================================================
    //  数据获取逻辑
    // =========================================================
    
    function getSubIdsFromSteam(appId, callback) {
        const url = `${API_STEAM_DETAILS}?appids=${appId}&cc=cn&l=schinese`;
        proxyRequest(url, (data) => {
            if (!data || !data[appId] || !data[appId].success) {
                callback(null);
                return;
            }
            const gameData = data[appId].data;
            const subIds = [];
            const subNames = {};
            if (gameData.package_groups) {
                gameData.package_groups.forEach(group => {
                    group.subs.forEach(sub => {
                        if (sub.can_get_free_license === '0' || sub.price_in_cents_with_discount > 0) {
                            subIds.push(sub.packageid);
                            let name = sub.option_text.replace(/Purchase |Buy /gi, '').replace(/\(.*\)/, '').trim();
                            subNames[sub.packageid] = name;
                        }
                    });
                });
            }
            callback({ ids: subIds, names: subNames });
        });
    }

    function fetchPricesBySubIds(subIdList, nameMap, appId, callback) {
        if (!subIdList || subIdList.length === 0) { callback([]); return; }
        const targets = subIdList.slice(0, 3);
        let results = [];
        let completed = 0;

        targets.forEach(subId => {
            const url = `${API_PY_STORE}?subId=${subId}&appId=${appId}&type=subid`;
            proxyRequest(url, (data) => {
                if (data && data.success && data.result) {
                    const res = data.result;
                    res.versionName = nameMap[subId] || "标准版"; 
                    results.push(res);
                }
                completed++;
                if (completed === targets.length) callback(results);
            });
        });
    }

    function fetchPriceByName(gameName, targetAppId, callback) {
        const cleanName = gameName.replace(/[™®©]/g, '').replace(/[:：-]/g, ' ').trim();
        const url = `${API_PY_SEARCH}?pageNumber=1&pageSize=20&sort=keyTx&order=asc&gameName=${encodeURIComponent(cleanName)}`;
        proxyRequest(url, (data) => {
            if (data && data.success && data.result) {
                const list = data.result.content || (Array.isArray(data.result) ? data.result : []);
                let matches = list.filter(item => String(item.appId) === String(targetAppId));
                if (matches.length === 0) {
                    matches = list.filter(item => item.gameName.toLowerCase().includes(cleanName.toLowerCase())).slice(0, 3);
                }
                matches.forEach(m => m.versionName = m.gameName); 
                callback(matches);
            } else {
                callback([]);
            }
        });
    }

    // =========================================================
    //  UI 渲染
    // =========================================================
    function generateHTML(results) {
        if (!results || results.length === 0) {
            return `<div class="cortana-price-box"><div class="cortana-row" style="justify-content:center;color:#888;">未找到 SteamPy 货源</div></div>`;
        }

        let html = `
            <div class="cortana-price-box">
                <div class="cortana-header">
                    <span class="cortana-badge">PY</span> 找到 ${results.length} 个版本
                </div>
                <div class="cortana-prices" style="max-height: 300px; overflow-y: auto;">`;

        results.forEach((item, index) => {
            const dai = item.daiPrice ? Number(item.daiPrice) : 0;
            const key = item.keyPrice ? Number(item.keyPrice) : 0;
            
            if (dai === 0 && key === 0) return;

            const borderStyle = index > 0 ? "border-top: 1px dashed rgba(255,255,255,0.15); margin-top: 8px; padding-top: 8px;" : "";
            const displayName = item.versionName || item.gameName;

            html += `<div style="${borderStyle}">
                <div style="font-size: 13px; color: #fff; margin-bottom: 6px; font-weight: bold; padding-left: 4px; border-left: 3px solid #66c0f4; line-height: 1.2;" title="${displayName}">
                    &nbsp;${displayName}
                </div>`;

            if (dai > 0) {
                html += `
                    <div class="cortana-row" style="margin-bottom: 4px;">
                        <span class="label" style="color:#888; width: 40px;">代购</span>
                        <span class="price" style="color:#BEEE11; font-weight:bold; font-size:15px; flex-grow: 1;">¥${dai.toFixed(2)}</span>
                        <a href="https://steampy.com/hotGameDetail?gameId=${item.id}" target="_blank" class="buy-btn">购买</a>
                    </div>`;
            }

            if (key > 0) {
                html += `
                    <div class="cortana-row">
                        <span class="label" style="color:#888; width: 40px;">CDK</span>
                        <span class="price" style="color:#BEEE11; font-weight:bold; font-size:15px; flex-grow: 1;">¥${key.toFixed(2)}</span>
                        <a href="https://steampy.com/cdkDetail?name=cn&gameId=${item.id}" target="_blank" class="buy-btn">购买</a>
                    </div>`;
            }
            html += `</div>`;
        });
        
        html += `</div></div>`;
        return html;
    }

    // =========================================================
    //  页面注入逻辑
    // =========================================================
    
    function handleStorePage() {
        if (!location.pathname.includes('/app/')) return;
        const appId = location.pathname.match(/\/app\/(\d+)/)?.[1];
        if (!appId) return;

        document.querySelectorAll('form[name^="add_to_cart_"]').forEach(form => {
            if (form.dataset.cortana) return;
            form.dataset.cortana = "true";
            const input = form.querySelector('input[name="subid"], input[name="bundleid"]');
            if (input) {
                const url = `${API_PY_STORE}?subId=${input.value}&appId=${appId}&type=${input.name}`;
                proxyRequest(url, (data) => {
                    if (data && data.success) {
                        const div = document.createElement('div');
                        const item = data.result;
                        item.versionName = "当前选择版本";
                        div.innerHTML = generateHTML([item]);
                        form.parentElement.appendChild(div.firstElementChild);
                    }
                });
            }
        });
    }

    function handleWishlistPage() {
        if (!location.pathname.includes('/wishlist/')) return;
        const rows = document.querySelectorAll('div[data-index]');

        rows.forEach(row => {
            if (row.dataset.cortana) return;

            const appLinks = row.querySelectorAll('a[href*="/app/"]');
            let gameName = "";
            let appId = "";
            for (const link of appLinks) {
                if (!appId) { const m = link.href.match(/\/app\/(\d+)/); if (m) appId = m[1]; }
                if (link.innerText && link.innerText.trim().length > 0) gameName = link.innerText.trim();
            }
            if (!gameName && row.querySelector('.title')) gameName = row.querySelector('.title').innerText.trim();
            if (!appId || !gameName) return;

            let targetContainer = row.querySelector('.a3nhjc9lykk-');
            if (!targetContainer) {
                const btns = row.querySelectorAll('button');
                for (let btn of btns) {
                    if (btn.innerText.match(/(车|Cart|Add)/)) { targetContainer = btn.parentElement; break; }
                }
            }
            if (!targetContainer) return;

            row.dataset.cortana = "true";

            const btn = document.createElement('div');
            btn.innerText = '🔍 PY查价';
            
            btn.style.cssText = `
                align-self: center;
                order: -1;
                display: inline-block;
                background: rgba(0, 0, 0, 0.2); 
                color: #66c0f4; 
                border: 1px solid rgba(102, 192, 244, 0.3); 
                border-radius: 4px; 
                padding: 0 10px; 
                height: 26px; 
                line-height: 24px; 
                font-size: 13px; 
                cursor: pointer; 
                margin-right: 12px; 
                white-space: nowrap; 
                user-select: none; 
                transition: all 0.2s ease;
                font-family: "Motiva Sans", Sans-serif;
            `;

            btn.onmouseenter = () => {
                if (!btn.classList.contains('loading')) {
                    btn.style.background = '#66c0f4';
                    btn.style.color = '#fff';
                    btn.style.borderColor = '#66c0f4';
                    btn.style.boxShadow = '0 0 8px rgba(102, 192, 244, 0.4)';
                }
            };
            btn.onmouseleave = () => {
                if (!btn.classList.contains('loading')) {
                    btn.style.background = 'rgba(0, 0, 0, 0.2)';
                    btn.style.color = '#66c0f4';
                    btn.style.borderColor = 'rgba(102, 192, 244, 0.3)';
                    btn.style.boxShadow = 'none';
                }
            };

            btn.onclick = (e) => {
                e.stopPropagation(); e.preventDefault();
                if (btn.classList.contains('loading')) return;
                
                const existing = row.querySelector('.cortana-price-box');
                if (existing) { existing.remove(); return; }

                btn.innerText = '查价中...';
                btn.classList.add('loading');
                btn.style.opacity = '0.7';
                btn.style.cursor = 'wait';

                getSubIdsFromSteam(appId, (steamData) => {
                    const handleResults = (results) => {
                        btn.innerText = '🔍 PY查价';
                        btn.classList.remove('loading');
                        btn.style.opacity = '1';
                        btn.style.cursor = 'pointer';
                        
                        const html = generateHTML(results);
                        const container = document.createElement('div');
                        container.style.width = "100%"; container.style.marginTop = "5px";
                        container.innerHTML = html;
                        row.appendChild(container);
                    };

                    if (steamData && steamData.ids.length > 0) {
                        fetchPricesBySubIds(steamData.ids, steamData.names, appId, (prices) => {
                            if (prices.length > 0) handleResults(prices);
                            else fetchPriceByName(gameName, appId, handleResults);
                        });
                    } else {
                        fetchPriceByName(gameName, appId, handleResults);
                    }
                });
            };

            targetContainer.style.display = 'flex';
            targetContainer.style.alignItems = 'center';
            targetContainer.insertBefore(btn, targetContainer.firstChild);
        });
    }

    // =========================================================
    //  主循环 (性能优化核心修改)
    // =========================================================
    
    let debounceTimer = null;

    const observer = new MutationObserver(() => {
        // 1. 如果有新的 DOM 变动，清除上一次的计时器
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }

        // 2. 重新设置计时器，500毫秒后执行
        debounceTimer = setTimeout(() => {
            handleStorePage();
            handleWishlistPage();
        }, 500); 
    });
    
    observer.observe(document.body, { childList: true, subtree: true });
    
    // 立即执行一次 (页面加载时)
    setTimeout(() => { 
        handleStorePage(); 
        handleWishlistPage(); 
    }, 500);

})();