const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept',
};

const HTML_CONTENT = `
<!DOCTYPE html>
<html>
<head>
    <title>HLS Proxy Test</title>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@1.4.12"></script>
    <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        input, textarea { width: 100%; padding: 8px; margin: 10px 0; }
        button { padding: 8px 16px; background: #4CAF50; color: white; border: none; cursor: pointer; margin-right: 10px; }
        video { width: 100%; margin-top: 20px; }
        #status { margin-top: 10px; color: #666; }
        #qualitySelector { margin: 10px 0; }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; font-weight: bold; }
        .help-text { font-size: 0.8em; color: #666; margin-top: 3px; }
    </style>
</head>
<body>
    <h1>HLS Proxy Test</h1>
    
    <div class="form-group">
        <label for="m3u8Url">M3U8 URL:</label>
        <input type="text" id="m3u8Url" placeholder="Enter original m3u8 URL" 
               value="https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8">
    </div>
    
    <div class="form-group">
        <label for="customHeaders">Custom Headers (JSON format):</label>
        <textarea id="customHeaders" rows="5" placeholder='{"Referer": "https://example.com", "Origin": "https://example.com"}'></textarea>
        <div class="help-text">Example: {"Referer": "https://example.com", "Origin": "https://example.com"}</div>
    </div>
    
    <button onclick="loadVideo()">Load Video</button>
    <div id="status">Status: Ready</div>
    
    <div id="qualitySelector" style="display: none;">
        <label for="quality">Quality:</label>
        <select id="quality" onchange="changeQuality()"></select>
    </div>
    
    <video id="video" controls></video>
    
    <script>
        let hls = null;
        let levels = [];
        
        function loadVideo() {
            const originalUrl = document.getElementById('m3u8Url').value;
            const customHeadersText = document.getElementById('customHeaders').value;
            const statusEl = document.getElementById('status');
            const qualitySelector = document.getElementById('qualitySelector');
            const qualitySelect = document.getElementById('quality');
            const video = document.getElementById('video');
            
            qualitySelect.innerHTML = '';
            qualitySelector.style.display = 'none';
            
            let headersParam = '';
            if (customHeadersText.trim()) {
                try {
                    const customHeaders = JSON.parse(customHeadersText);
                    headersParam = encodeURIComponent(JSON.stringify(customHeaders));
                } catch (e) {
                    statusEl.textContent = 'Status: Error parsing headers JSON';
                    return;
                }
            }
            
            const proxyUrl = '/proxy/m3u8?url=' + encodeURIComponent(originalUrl) + 
                            (headersParam ? '&headers=' + headersParam : '');
            
            statusEl.textContent = 'Status: Loading...';
            
            if (hls) {
                hls.destroy();
            }
            
            if (Hls.isSupported()) {
                hls = new Hls({
                    debug: true,
                    enableWorker: true,
                    lowLatencyMode: false,
                    backBufferLength: 90
                });
                
                hls.on(Hls.Events.ERROR, function(event, data) {
                    console.error('HLS error:', data);
                    statusEl.textContent = 'Status: Error - ' + data.details;
                });
                
                hls.on(Hls.Events.MANIFEST_PARSED, function(event, data) {
                    statusEl.textContent = 'Status: Manifest parsed, attempting playback';
                    
                    levels = data.levels;
                    if (levels.length > 1) {
                        const autoOption = document.createElement('option');
                        autoOption.value = -1;
                        autoOption.text = 'Auto';
                        qualitySelect.add(autoOption);
                        
                        levels.forEach((level, index) => {
                            const option = document.createElement('option');
                            option.value = index;
                            let label = '';
                            if (level.height) label += level.height + 'p';
                            if (level.bitrate) label += (label ? ' @ ' : '') + Math.round(level.bitrate / 1000) + ' kbps';
                            if (!label) label = 'Quality ' + (index + 1);
                            option.text = label;
                            qualitySelect.add(option);
                        });
                        
                        qualitySelector.style.display = 'block';
                    }
                    
                    video.play().catch(e => {
                        console.error('Playback failed:', e);
                        statusEl.textContent = 'Status: Playback failed - ' + e.message;
                    });
                });
                
                hls.on(Hls.Events.MEDIA_ATTACHED, function() {
                    statusEl.textContent = 'Status: Media attached';
                });
                
                hls.loadSource(proxyUrl);
                hls.attachMedia(video);
                
                video.addEventListener('playing', function() {
                    statusEl.textContent = 'Status: Playing';
                });
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = proxyUrl;
                video.addEventListener('loadedmetadata', function() {
                    statusEl.textContent = 'Status: Metadata loaded, attempting playback';
                    video.play().catch(e => {
                        console.error('Playback failed:', e);
                        statusEl.textContent = 'Status: Playback failed - ' + e.message;
                    });
                });
                
                video.addEventListener('playing', function() {
                    statusEl.textContent = 'Status: Playing';
                });
                
                video.addEventListener('error', function() {
                    statusEl.textContent = 'Status: Error - ' + (video.error ? video.error.message : 'Unknown');
                });
            } else {
                statusEl.textContent = 'Status: HLS is not supported in your browser';
                alert('HLS is not supported in your browser');
            }
        }
        
        function changeQuality() {
            if (!hls) return;
            const qualityIndex = parseInt(document.getElementById('quality').value);
            hls.currentLevel = qualityIndex;
            const statusEl = document.getElementById('status');
            if (qualityIndex === -1) {
                statusEl.textContent = 'Status: Switched to Auto quality';
            } else if (levels[qualityIndex]) {
                let qualityInfo = '';
                if (levels[qualityIndex].height) qualityInfo += levels[qualityIndex].height + 'p';
                if (levels[qualityIndex].bitrate) qualityInfo += (qualityInfo ? ' @ ' : '') + 
                    Math.round(levels[qualityIndex].bitrate / 1000) + ' kbps';
                statusEl.textContent = 'Status: Switched to ' + (qualityInfo || 'Quality ' + (qualityIndex + 1));
            }
        }
    </script>
</body>
</html>
`;

function parseCustomHeaders(headersParam) {
	if (!headersParam) return {};
	try {
		return JSON.parse(headersParam);
	} catch (error) {
		return {};
	}
}

async function handleM3u8Proxy(request) {
	const url = new URL(request.url);
	const targetUrl = url.searchParams.get('url');
	const headersParam = url.searchParams.get('headers');
	const customHeaders = parseCustomHeaders(headersParam);

	if (!targetUrl) {
		return corsResponse('Missing url parameter', 400);
	}

	try {
		console.log(`Fetching M3U8 from: ${targetUrl}`);

		// Prepare headers with defaults and custom overrides
		const headers = {
			'User-Agent':
				request.headers.get('user-agent') ||
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
			Accept: '*/*',
			'Accept-Language': 'en-US,en;q=0.9',
			Referer: 'https://megacloud.club',
			Connection: 'keep-alive',
			'X-Forwarded-For': request.headers.get('cf-connecting-ip') || '127.0.0.1',
			'X-Real-IP': request.headers.get('cf-connecting-ip') || '127.0.0.1',
			...customHeaders,
		};

		// Log the headers we're sending
		console.log('Request headers:', JSON.stringify(headers));

		// Fetch the M3U8 content
		let response = await fetch(targetUrl, {
			headers,
			redirect: 'follow',
		});

		// Log response status and headers
		console.log(`Response status: ${response.status} ${response.statusText}`);
		const responseHeaders = {};
		response.headers.forEach((value, key) => {
			responseHeaders[key] = value;
		});
		console.log('Response headers:', JSON.stringify(responseHeaders));

		let m3u8Content = '';
		if (response.ok) {
			m3u8Content = await response.text();
			console.log(`Original M3U8 content length: ${m3u8Content.length}`);
		}

		if (m3u8Content.length === 0) {
			return corsResponse('Empty M3U8 content received from source', 500);
		}

		const parsedUrl = new URL(targetUrl);
		const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
		const basePath = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

		const modifiedLines = m3u8Content.split('\n').map((line) => {
			if (line.startsWith('#EXT-X-KEY')) {
				const keyPattern = /(URI=")([^"]+)(")/;
				const match = line.match(keyPattern);
				if (match) {
					let keyUrl = match[2];
					if (!keyUrl.startsWith('http')) {
						keyUrl = keyUrl.startsWith('/') ? `${baseUrl}${keyUrl}` : `${basePath}${keyUrl}`;
					}
					return line.replace(
						keyPattern,
						`$1/proxy/key?url=${encodeURIComponent(keyUrl)}&headers=${encodeURIComponent(url.searchParams.get('headers') || '')}$3`
					);
				}
				return line;
			} else if (line.startsWith('#') || line.trim() === '') {
				return line;
			}

			let absoluteUrl;
			if (line.startsWith('http')) {
				absoluteUrl = line;
			} else if (line.startsWith('/')) {
				absoluteUrl = `${baseUrl}${line}`;
			} else {
				absoluteUrl = `${basePath}${line}`;
			}

			if (line.endsWith('.m3u8')) {
				return `/proxy/m3u8?url=${encodeURIComponent(absoluteUrl)}&headers=${encodeURIComponent(url.searchParams.get('headers') || '')}`;
			} else {
				return `/proxy/segment?url=${encodeURIComponent(absoluteUrl)}&headers=${encodeURIComponent(url.searchParams.get('headers') || '')}`;
			}
		});

		return corsResponse(modifiedLines.join('\n'), 200, 'application/vnd.apple.mpegurl');
	} catch (error) {
		console.error('Error proxying m3u8:', error.message, error.stack);
		return corsResponse(`Proxy error: ${error.message}`, 500);
	}
}

async function handleProxyRequest(url, request, path) {
	const targetUrl = url.searchParams.get('url');
	const customHeaders = parseCustomHeaders(url.searchParams.get('headers'));

	if (!targetUrl) return new Response('Missing url parameter', { status: 400 });

	const headers = {
		'User-Agent': request.headers.get('user-agent') || 'HLS-Proxy',
		Referer: new URL(targetUrl).origin,
		...customHeaders,
	};

	try {
		const response = await fetch(targetUrl, { headers });
		const contentType = response.headers.get('content-type') || (path === 'key' ? 'application/octet-stream' : 'video/MP2T');

		return new Response(response.body, {
			headers: {
				'Content-Type': contentType,
				...CORS_HEADERS,
			},
		});
	} catch (error) {
		return new Response(`Proxy error: ${error.message}`, { status: 500 });
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const path = url.pathname;

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: CORS_HEADERS });
		}

		if (path === '/') {
			return new Response(HTML_CONTENT, {
				headers: {
					'Content-Type': 'text/html',
					...CORS_HEADERS,
				},
			});
		}

		if (path === '/proxy/m3u8') {
			return handleM3u8Proxy(request);
		}

		if (path === '/proxy/segment' || path === '/proxy/key') {
			return handleProxyRequest(url, request, path.split('/').pop());
		}

		return new Response('Not Found', { status: 404 });
	},
};
