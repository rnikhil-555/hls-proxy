// Helper function to parse headers from query parameter
function parseCustomHeaders(headersParam) {
	if (!headersParam) return {};

	try {
		return JSON.parse(decodeURIComponent(headersParam));
	} catch (error) {
		console.error('Error parsing custom headers:', error);
		return {};
	}
}

// Helper function to create response with CORS headers
function corsResponse(body, status = 200, contentType = 'text/plain') {
	return new Response(body, {
		status,
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, OPTIONS',
			'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept',
			'Content-Type': contentType,
		},
	});
}

// Proxy for m3u8 playlists
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
			Referer: 'https://megacloud.club' || new URL(targetUrl).origin,
			Connection: 'keep-alive',
			...customHeaders,
		};

		// Log the headers we're sending
		console.log('Request headers:', JSON.stringify(headers));

		const response = await fetch(targetUrl, {
			headers,
			redirect: 'follow',
		});
		console.log(response);
		if (!response.ok) {
			console.error(`Upstream server error: ${response.status} ${response.statusText}`);
			return corsResponse(`Upstream server error: ${response.status} ${response.statusText}`, response.status);
		}

		// Log response headers to debug
		const responseHeaders = {};
		response.headers.forEach((value, key) => {
			responseHeaders[key] = value;
		});
		console.log('Response headers:', JSON.stringify(responseHeaders));

		let m3u8Content = await response.text();
		console.log(`Original M3U8 content length: ${m3u8Content.length}`);

		if (m3u8Content.length === 0) {
			// Try a direct fetch without Cloudflare Worker
			const directFetchUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`;
			console.log(`Trying alternative fetch via: ${directFetchUrl}`);

			const directResponse = await fetch(directFetchUrl);
			if (!directResponse.ok) {
				return corsResponse('Empty M3U8 content received from source and alternative fetch failed', 500);
			}

			m3u8Content = await directResponse.text();
			console.log(`Alternative fetch content length: ${m3u8Content.length}`);

			if (m3u8Content.length === 0) {
				return corsResponse('Empty M3U8 content received from all sources', 500);
			}
		}

		// Fix for manifests that have everything on a single line
		// First, add newlines after each tag
		m3u8Content = m3u8Content.replace(/(#EXT[^#]*?)(\s+#)/g, '$1\n$2');

		// Then separate tags from their content
		m3u8Content = m3u8Content.replace(/(#EXT-X-STREAM-INF:[^\n]+)\s+([^\s#][^\n]*)/g, '$1\n$2');

		// Parse the base URL for resolving relative paths
		const parsedUrl = new URL(targetUrl);
		const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
		const basePath = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

		// Get the current origin for building absolute URLs
		const proxyOrigin = url.origin;

		// Replace relative URLs with absolute ones and route through our proxy
		const lines = m3u8Content.split('\n');
		const modifiedLines = lines.map((line) => {
			const trimmedLine = line.trim();

			// Skip empty lines
			if (trimmedLine === '') {
				return '';
			}

			// Handle I-FRAME-STREAM-INF which contains URI attribute
			if (trimmedLine.startsWith('#EXT-X-I-FRAME-STREAM-INF') && trimmedLine.includes('URI="')) {
				const uriPattern = /(URI=")([^"]+)(")/;
				const match = trimmedLine.match(uriPattern);
				if (match) {
					let iframeUrl = match[2];
					// Resolve relative URL to absolute
					if (!iframeUrl.startsWith('http')) {
						if (iframeUrl.startsWith('/')) {
							iframeUrl = `${baseUrl}${iframeUrl}`;
						} else {
							iframeUrl = `${basePath}${iframeUrl}`;
						}
					}
					// Replace with proxied URL
					const proxyIframeUrl = `${proxyOrigin}/proxy/m3u8?url=${encodeURIComponent(iframeUrl)}&headers=${encodeURIComponent(
						headersParam || ''
					)}`;
					return trimmedLine.replace(uriPattern, `$1${proxyIframeUrl}$3`);
				}
			}
			// Handle encryption keys
			else if (trimmedLine.startsWith('#EXT-X-KEY') && trimmedLine.includes('URI="')) {
				const keyPattern = /(URI=")([^"]+)(")/;
				const match = trimmedLine.match(keyPattern);
				if (match) {
					let keyUrl = match[2];
					// Resolve relative key URL to absolute
					if (!keyUrl.startsWith('http')) {
						if (keyUrl.startsWith('/')) {
							keyUrl = `${baseUrl}${keyUrl}`;
						} else {
							keyUrl = `${basePath}${keyUrl}`;
						}
					}
					// Replace with proxied key URL
					const proxyKeyUrl = `${proxyOrigin}/proxy/key?url=${encodeURIComponent(keyUrl)}&headers=${encodeURIComponent(
						headersParam || ''
					)}`;
					return trimmedLine.replace(keyPattern, `$1${proxyKeyUrl}$3`);
				}
			}
			// Pass through all other tags unchanged
			else if (trimmedLine.startsWith('#')) {
				return trimmedLine;
			}

			// Handle content lines (usually URLs to segments or other playlists)
			let absoluteUrl;
			if (trimmedLine.startsWith('http')) {
				absoluteUrl = trimmedLine;
			} else if (trimmedLine.startsWith('/')) {
				absoluteUrl = `${baseUrl}${trimmedLine}`;
			} else {
				absoluteUrl = `${basePath}${trimmedLine}`;
			}

			// Check if this is another m3u8 file (variant playlist)
			if (trimmedLine.endsWith('.m3u8')) {
				return `${proxyOrigin}/proxy/m3u8?url=${encodeURIComponent(absoluteUrl)}&headers=${encodeURIComponent(headersParam || '')}`;
			} else if (trimmedLine.match(/\.(ts|aac|mp4|vtt|webvtt)($|\?)/i)) {
				// For ts segments and other media files
				return `${proxyOrigin}/proxy/segment?url=${encodeURIComponent(absoluteUrl)}&headers=${encodeURIComponent(headersParam || '')}`;
			} else {
				// For any other files, also proxy them as segments
				return `${proxyOrigin}/proxy/segment?url=${encodeURIComponent(absoluteUrl)}&headers=${encodeURIComponent(headersParam || '')}`;
			}
		});

		const modifiedContent = modifiedLines.join('\n');
		console.log(`Modified M3U8 content length: ${modifiedContent.length}`);

		// Return the modified m3u8 with appropriate content type
		return new Response(modifiedContent, {
			status: 200,
			headers: {
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, OPTIONS',
				'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept',
				'Content-Type': 'application/vnd.apple.mpegurl',
				'Content-Length': modifiedContent.length.toString(),
			},
		});
	} catch (error) {
		console.error('Error proxying m3u8:', error.message, error.stack);
		return corsResponse(`Proxy error: ${error.message}`, 500);
	}
}

// Proxy for video segments (ts files, etc.)
async function handleSegmentProxy(request) {
	const url = new URL(request.url);
	const targetUrl = url.searchParams.get('url');
	const headersParam = url.searchParams.get('headers');
	const customHeaders = parseCustomHeaders(headersParam);

	if (!targetUrl) {
		return corsResponse('Missing url parameter', 400);
	}

	try {
		// Prepare headers with defaults and custom overrides
		const headers = {
			'User-Agent': request.headers.get('user-agent') || 'HLS-Proxy',
			Referer: new URL(targetUrl).origin,
			...customHeaders,
		};

		const response = await fetch(targetUrl, {
			headers,
		});

		if (!response.ok) {
			return corsResponse(`Upstream server error: ${response.status}`, response.status);
		}

		// Get the response as an ArrayBuffer
		const data = await response.arrayBuffer();

		// Create response headers
		const responseHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, OPTIONS',
			'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept',
			'Content-Type': response.headers.get('content-type') || 'video/MP2T',
		};

		// Add content-length if available
		const contentLength = response.headers.get('content-length');
		if (contentLength) {
			responseHeaders['Content-Length'] = contentLength;
		}

		return new Response(data, {
			status: 200,
			headers: responseHeaders,
		});
	} catch (error) {
		console.error('Error proxying segment:', error.message);
		return corsResponse(`Proxy error: ${error.message}`, 500);
	}
}

// Add handler for encryption keys
async function handleKeyProxy(request) {
	const url = new URL(request.url);
	const targetUrl = url.searchParams.get('url');
	const headersParam = url.searchParams.get('headers');
	const customHeaders = parseCustomHeaders(headersParam);

	if (!targetUrl) {
		return corsResponse('Missing url parameter', 400);
	}

	try {
		// Prepare headers with defaults and custom overrides
		const headers = {
			'User-Agent': request.headers.get('user-agent') || 'HLS-Proxy',
			Referer: new URL(targetUrl).origin,
			...customHeaders,
		};

		const response = await fetch(targetUrl, {
			headers,
		});

		if (!response.ok) {
			return corsResponse(`Upstream server error: ${response.status}`, response.status);
		}

		// Get the response as an ArrayBuffer
		const data = await response.arrayBuffer();

		// Create response headers
		const responseHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, OPTIONS',
			'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept',
			'Content-Type': response.headers.get('content-type') || 'application/octet-stream',
		};

		// Add content-length if available
		const contentLength = response.headers.get('content-length');
		if (contentLength) {
			responseHeaders['Content-Length'] = contentLength;
		}

		return new Response(data, {
			status: 200,
			headers: responseHeaders,
		});
	} catch (error) {
		console.error('Error proxying key:', error.message);
		return corsResponse(`Proxy error: ${error.message}`, 500);
	}
}

// Simple test page
function handleHomePage() {
	const html = `
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
          
          // Reset quality selector
          qualitySelect.innerHTML = '';
          qualitySelector.style.display = 'none';
          
          // Parse custom headers
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
              
              // Handle quality levels
              levels = data.levels;
              if (levels.length > 1) {
                // Add auto option
                const autoOption = document.createElement('option');
                autoOption.value = -1;
                autoOption.text = 'Auto';
                qualitySelect.add(autoOption);
                
                // Add each quality level
                levels.forEach((level, index) => {
                  const option = document.createElement('option');
                  option.value = index;
                  
                  // Format the label based on available information
                  let label = '';
                  if (level.height) {
                    label += level.height + 'p';
                  }
                  if (level.bitrate) {
                    label += (label ? ' @ ' : '') + Math.round(level.bitrate / 1000) + ' kbps';
                  }
                  if (!label) {
                    label = 'Quality ' + (index + 1);
                  }
                  
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
            // Native HLS support (Safari)
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
            
            // Note: Quality selection not available with native HLS
            statusEl.textContent += ' (Quality selection not available with native HLS player)';
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
            if (levels[qualityIndex].height) {
              qualityInfo += levels[qualityIndex].height + 'p';
            }
            if (levels[qualityIndex].bitrate) {
              qualityInfo += (qualityInfo ? ' @ ' : '') + 
                Math.round(levels[qualityIndex].bitrate / 1000) + ' kbps';
            }
            statusEl.textContent = 'Status: Switched to ' + (qualityInfo || 'Quality ' + (qualityIndex + 1));
          }
        }
      </script>
    </body>
    </html>
  `;

	return new Response(html, {
		status: 200,
		headers: {
			'Content-Type': 'text/html',
			'Access-Control-Allow-Origin': '*',
		},
	});
}

// Main event handler for the worker
export default {
	async fetch(request, env, ctx) {
		try {
			const url = new URL(request.url);
			const path = url.pathname;

			// Handle OPTIONS requests for CORS
			if (request.method === 'OPTIONS') {
				return new Response(null, {
					status: 204,
					headers: {
						'Access-Control-Allow-Origin': '*',
						'Access-Control-Allow-Methods': 'GET, OPTIONS',
						'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept',
					},
				});
			}

			// Route requests based on path
			if (path === '/') {
				return handleHomePage();
			} else if (path === '/proxy/m3u8') {
				return await handleM3u8Proxy(request);
			} else if (path === '/proxy/segment') {
				return await handleSegmentProxy(request);
			} else if (path === '/proxy/key') {
				return await handleKeyProxy(request);
			} else {
				return corsResponse('Not Found', 404);
			}
		} catch (error) {
			console.error('Unhandled error:', error);
			return corsResponse(`Server error: ${error.message}`, 500);
		}
	},
};

//fix
