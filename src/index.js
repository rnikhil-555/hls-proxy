import { Router } from 'itty-router';

// Create a new router
const router = Router();

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

// Handle OPTIONS requests for CORS
router.options('*', () => {
	return new Response(null, {
		status: 204,
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, OPTIONS',
			'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept',
		},
	});
});

// Proxy for m3u8 playlists
router.get('/proxy/m3u8', async (request) => {
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

		const m3u8Content = await response.text();

		// Parse the base URL for resolving relative paths
		const parsedUrl = new URL(targetUrl);
		const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
		const basePath = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

		// Replace relative URLs with absolute ones and route through our proxy
		const lines = m3u8Content.split('\n');
		const modifiedLines = lines.map((line) => {
			// Skip comments and tags, but handle EXT-X-KEY which may contain URIs
			if (line.startsWith('#EXT-X-KEY')) {
				// Handle encryption keys in the playlist
				if (line.includes('URI="')) {
					const keyPattern = /(URI=")([^"]+)(")/;
					const match = line.match(keyPattern);
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
						return line.replace(
							keyPattern,
							`$1/proxy/key?url=${encodeURIComponent(keyUrl)}&headers=${encodeURIComponent(headersParam || '')}$3`
						);
					}
				}
				return line;
			} else if (line.startsWith('#') || line.trim() === '') {
				return line;
			}

			// Handle relative URLs
			let absoluteUrl;
			if (line.startsWith('http')) {
				absoluteUrl = line;
			} else if (line.startsWith('/')) {
				absoluteUrl = `${baseUrl}${line}`;
			} else {
				absoluteUrl = `${basePath}${line}`;
			}

			// Check if this is another m3u8 file (variant playlist)
			if (line.endsWith('.m3u8')) {
				return `/proxy/m3u8?url=${encodeURIComponent(absoluteUrl)}&headers=${encodeURIComponent(headersParam || '')}`;
			} else {
				// For ts segments and other files
				return `/proxy/segment?url=${encodeURIComponent(absoluteUrl)}&headers=${encodeURIComponent(headersParam || '')}`;
			}
		});

		const modifiedContent = modifiedLines.join('\n');

		// Return the modified m3u8 with appropriate content type
		return corsResponse(modifiedContent, 200, 'application/vnd.apple.mpegurl');
	} catch (error) {
		console.error('Error proxying m3u8:', error.message);
		return corsResponse(`Proxy error: ${error.message}`, 500);
	}
});

// Proxy for video segments (ts files, etc.)
router.get('/proxy/segment', async (request) => {
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
});

// Add handler for encryption keys
router.get('/proxy/key', async (request) => {
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
});

// Simple test page
router.get('/', () => {
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
});

// Catch-all handler for any other requests
router.all('*', () => corsResponse('Not Found', 404));

// Main event handler for the worker
export default {
	async fetch(request, env, ctx) {
		try {
			return await router.handle(request);
		} catch (error) {
			console.error('Unhandled error:', error);
			return corsResponse(`Server error: ${error.message}`, 500);
		}
	},
};
