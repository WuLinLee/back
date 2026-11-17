// background.js - Service Worker (Manifest V3 适配版)

// 允许请求的域名白名单 (发布到 Chrome 商店必须严格限制)
const ALLOWED_DOMAINS = [
    "steampy.com",
    "store.steampowered.com"
];

// 校验 URL 是否合法
function isUrlAllowed(url) {
    try {
        const urlObj = new URL(url);
        // 检查 hostname 是否以白名单域名结尾
        return ALLOWED_DOMAINS.some(domain => urlObj.hostname.endsWith(domain));
    } catch (e) {
        return false;
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'fetchPrice') {
        const targetUrl = request.url;
        
        // 安全检查：如果请求的 URL 不在白名单内，直接拒绝
        if (!isUrlAllowed(targetUrl)) {
            console.error(`[Cortana Security] 拦截了非法请求: ${targetUrl}`);
            sendResponse({ success: false, error: "Domain not allowed by security policy." });
            return false;
        }

        console.log(`[Cortana SW] 正在请求: ${targetUrl}`);

        fetch(targetUrl)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                return response.json();
            })
            .then(data => sendResponse({ success: true, data: data }))
            .catch(error => {
                console.error("[Cortana Error]", error);
                sendResponse({ success: false, error: error.toString() });
            });

        return true; // 保持消息通道开启以进行异步响应
    }
});