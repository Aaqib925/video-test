import express, { Request, Response } from 'express';
import * as path from 'path';
import fs from 'fs';
import axios from 'axios';
import ytdl from 'ytdl-core';
import { exec, spawn } from 'child_process';
import dotenv from 'dotenv';
import { promisify } from 'util';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

// Promisify exec
const execAsync = promisify(exec);

// Load environment variables
dotenv.config();

// Configure Express app
const app = express();
const port = process.env.PORT || 3000;
const DOWNLOAD_DIR = path.join(__dirname, '..', 'downloads');
const COOKIES_FILE = path.join(__dirname, '..', 'cookies.txt');

// Create downloads directory if it doesn't exist
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  console.log(`📁 Created downloads directory: ${DOWNLOAD_DIR}`);
}

// Configure middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper function for formatted logging
function log(message: string, type: 'info' | 'success' | 'error' | 'warn' | 'debug' = 'info') {
  const timestamp = new Date().toISOString();
  let prefix = '';
  
  switch(type) {
    case 'success':
      prefix = '✅ ';
      break;
    case 'error':
      prefix = '❌ ';
      break;
    case 'warn':
      prefix = '⚠️ ';
      break;
    case 'debug':
      prefix = '🔍 ';
      break;
    default:
      prefix = 'ℹ️ ';
  }
  
  console.log(`${prefix}[${timestamp}] ${message}`);
}

// Types for YouTube API responses
interface YouTubeVideoItem {
  id: string;
  snippet: {
    title: string;
    description: string;
    publishedAt: string;
    channelTitle: string;
    thumbnails: {
      high: {
        url: string;
      }
    }
  };
  contentDetails: {
    duration: string;
  };
  statistics: {
    viewCount: string;
    likeCount: string;
  };
}

interface YouTubeVideoResponse {
  items: YouTubeVideoItem[];
}

// Setup route to serve static files
app.use('/downloads', express.static(DOWNLOAD_DIR));

/**
 * Check if the cookies file exists
 */
function hasCookiesFile(): boolean {
  const exists = fs.existsSync(COOKIES_FILE);
  if (exists) {
    const stats = fs.statSync(COOKIES_FILE);
    log(`Found cookies file: ${COOKIES_FILE} (${(stats.size / 1024).toFixed(2)} KB)`, 'success');
  } else {
    log(`No cookies file found at: ${COOKIES_FILE}`, 'warn');
  }
  return exists;
}

/**
 * Check if yt-dlp is installed
 */
async function isYtDlpInstalled(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('yt-dlp --version');
    log(`yt-dlp is installed. Version: ${stdout.trim()}`, 'success');
    return true;
  } catch (error) {
    log('yt-dlp is not installed or not in PATH', 'warn');
    return false;
  }
}

/**
 * Extract video ID from YouTube URL
 */
function extractVideoId(url: string): string | null {
  const regularMatch = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
  const match = url.match(regularMatch);
  return match ? match[1] : null;
}

/**
 * Get video details using YouTube Data API
 */
async function getVideoDetails(videoId: string, apiKey: string): Promise<YouTubeVideoItem | null> {
  try {
    log(`Fetching YouTube metadata for video ID: ${videoId}`);
    
    const response = await axios.get<YouTubeVideoResponse>(
      'https://www.googleapis.com/youtube/v3/videos',
      {
        params: {
          part: 'snippet,contentDetails,statistics',
          id: videoId,
          key: apiKey
        }
      }
    );

    if (response.data.items.length === 0) {
      log(`No video found with ID: ${videoId}`, 'error');
      return null;
    }

    const video = response.data.items[0];
    log(`Found video: "${video.snippet.title}" by ${video.snippet.channelTitle}`, 'success');
    log(`Video has ${video.statistics.viewCount} views and ${video.statistics.likeCount} likes`, 'info');
    return video;
  } catch (error) {
    log(`Error fetching video details: ${error}`, 'error');
    return null;
  }
}

/**
 * Method 1: Download with yt-dlp using cookies
 */
async function downloadWithYtDlpCookies(url: string, outputPath: string, videoId: string): Promise<boolean> {
  return new Promise((resolve) => {
    log('🔄 METHOD 1: Attempting download with yt-dlp using cookies...', 'info');
    
    // Check if cookies file exists
    if (!fs.existsSync(COOKIES_FILE)) {
      log('Cookies file not found. Skipping Method 1.', 'warn');
      resolve(false);
      return;
    }
    
    const args = [
      '--cookies', COOKIES_FILE,
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36',
      '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--output', outputPath,
      '--verbose',
      url
    ];
    
    log(`Starting yt-dlp process with cookies authentication`, 'info');
    
    const ytdlp = spawn('yt-dlp', args);
    
    ytdlp.stdout.on('data', (data) => {
      const output = data.toString().trim();
      
      // Only log important lines to avoid console spam
      if (output.includes('progress') || output.includes('Downloading') || 
          output.includes('Merging') || output.includes('Finished')) {
        console.log(`yt-dlp: ${output}`);
      }
      
      // Extract progress information if available
      const progressMatch = output.match(/(\d+\.\d+)%/);
      if (progressMatch) {
        const progress = progressMatch[1];
        if (parseFloat(progress) % 10 === 0) { // Log every 10%
          log(`Download progress: ${progress}%`, 'info');
        }
      }
    });
    
    ytdlp.stderr.on('data', (data) => {
      const error = data.toString().trim();
      log(`yt-dlp error: ${error}`, 'error');
    });
    
    ytdlp.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        const stats = fs.statSync(outputPath);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        
        log(`METHOD 1 SUCCESSFUL: yt-dlp with cookies download completed!`, 'success');
        log(`Video saved to: ${path.basename(outputPath)} (${fileSizeMB} MB)`, 'success');
        
        resolve(true);
      } else {
        log(`METHOD 1 FAILED: yt-dlp exited with code ${code}`, 'error');
        resolve(false);
      }
    });
  });
}

/**
 * Method 2: Download video using ytdl-core with enhanced options to avoid bot detection
 */
async function downloadWithEnhancedYtdl(url: string, outputPath: string, videoId: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      log('🔄 METHOD 2: Attempting download with enhanced ytdl-core settings...', 'info');
      
      const writeStream = fs.createWriteStream(outputPath);
      
      // Enhanced options to avoid bot detection
      const options = {
        quality: 'highest',
        requestOptions: {
          headers: {
            // Using a common browser user-agent
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36',
            // Adding common headers
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Cache-Control': 'max-age=0',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1'
          }
        }
      };
      
      log(`Starting ytdl-core with enhanced headers`, 'info');
      
      let lastLoggedProgress = 0;
      
      ytdl(url, options)
      .on('progress', (_, downloaded, total) => {
        if (total) {
          const percent = Math.floor(downloaded / total * 100);
          
          // Only log every 10% to avoid console spam
          if (percent >= lastLoggedProgress + 10 || percent === 100) {
            log(`Download progress: ${percent}%`, 'info');
            lastLoggedProgress = percent;
          }
        }
      })
      .on('info', (info) => {
        log(`Video info received: ${info.formats.length} formats available`, 'info');
      })
      .on('end', () => {
        if (fs.existsSync(outputPath)) {
          const stats = fs.statSync(outputPath);
          const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
          
          log(`METHOD 2 SUCCESSFUL: ytdl-core download completed`, 'success');
          log(`Video saved to: ${path.basename(outputPath)} (${fileSizeMB} MB)`, 'success');
          
          resolve(true);
        } else {
          log(`METHOD 2 FAILED: Output file does not exist`, 'error');
          resolve(false);
        }
      })
      .on('error', (err) => {
        log(`Enhanced ytdl-core download error: ${err}`, 'error');
        resolve(false);
      })
      .pipe(writeStream);
    } catch (error) {
      log(`Enhanced ytdl-core download exception: ${error}`, 'error');
      resolve(false);
    }
  });
}

/**
 * Method 3: Download using direct fetch with proxy
 */
async function downloadWithProxyFetch(url: string, outputPath: string, videoId: string): Promise<boolean> {
  try {
    log('🔄 METHOD 3: Attempting download with proxy fetch...', 'info');
    
    // Attempt to get the video info first
    log('Getting video info for direct URL fetch...', 'info');
    
    const info = await ytdl.getInfo(url, {
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36',
        }
      }
    });
    
    log(`Got video info. Title: "${info.videoDetails.title}"`, 'info');
    log(`Found ${info.formats.length} available formats`, 'info');
    
    const format = ytdl.chooseFormat(info.formats, { quality: 'highest' });
    
    if (!format || !format.url) {
      log('Could not get direct video URL', 'error');
      return false;
    }
    
    log(`Selected format: itag=${format.itag}, quality=${format.qualityLabel || 'unknown'}`, 'info');
    log(`Direct URL obtained. Starting download...`, 'info');
    
    // For secure requests, we create a temporary file to use as a buffer
    const tempFilePath = `${outputPath}.temp`;
    
    // Use axios with custom configuration to download
    const response = await axios({
      method: 'GET',
      url: format.url,
      responseType: 'stream',
      // Uncomment if you want to use a proxy
      // proxy: {
      //   host: 'your-proxy-host',
      //   port: 8080,
      // },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36',
        'Referer': 'https://www.youtube.com/',
        'Origin': 'https://www.youtube.com',
      }
    });
    
    // Get content length if available
    const contentLength = parseInt(response.headers['content-length'] || '0');
    if (contentLength > 0) {
      log(`Content size: ${(contentLength / (1024 * 1024)).toFixed(2)} MB`, 'info');
    }
    
    // Pipe the response to the file
    const writer = fs.createWriteStream(tempFilePath);
    
    // Set up progress tracking
    let downloadedBytes = 0;
    let lastLoggedPercent = 0;
    
    response.data.on('data', (chunk: Buffer) => {
      downloadedBytes += chunk.length;
      
      if (contentLength > 0) {
        const percent = Math.floor(downloadedBytes / contentLength * 100);
        
        // Only log every 10% to avoid console spam
        if (percent >= lastLoggedPercent + 10 || percent === 100) {
          log(`Download progress: ${percent}%`, 'info');
          lastLoggedPercent = percent;
        }
      } else {
        // If content length is not available, log based on MB downloaded
        if (downloadedBytes % (1024 * 1024 * 10) < 1024) { // Log every 10MB
          log(`Downloaded: ${(downloadedBytes / (1024 * 1024)).toFixed(2)} MB`, 'info');
        }
      }
    });
    
    response.data.pipe(writer);
    
    return new Promise((resolve) => {
      writer.on('finish', () => {
        // Move the temp file to the actual output path
        fs.renameSync(tempFilePath, outputPath);
        
        const stats = fs.statSync(outputPath);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        
        log(`METHOD 3 SUCCESSFUL: Proxy fetch download completed`, 'success');
        log(`Video saved to: ${path.basename(outputPath)} (${fileSizeMB} MB)`, 'success');
        
        resolve(true);
      });
      
      writer.on('error', (err) => {
        log(`Proxy fetch download error: ${err}`, 'error');
        resolve(false);
      });
    });
  } catch (error) {
    log(`Proxy fetch download exception: ${error}`, 'error');
    return false;
  }
}

/**
 * Method 4: Download using a YouTube embed URL
 */
async function downloadWithEmbedURL(videoId: string, outputPath: string): Promise<boolean> {
  try {
    log('🔄 METHOD 4: Attempting download with embed URL...', 'info');
    
    // YouTube embed URLs sometimes have different rate limiting
    const embedUrl = `https://www.youtube.com/embed/${videoId}`;
    
    // First get the embed page
    log(`Fetching embed page: ${embedUrl}`, 'info');
    
    const embedResponse = await axios.get(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36',
      }
    });
    
    log(`Embed page fetched successfully. Status: ${embedResponse.status}`, 'info');
    
    // This is a simplified example - in reality, we would need to parse the embed page
    // to find the video URL, which is not straightforward
    
    // For now, we'll use ytdl-core with the embed URL as a workaround
    log(`Starting download using embed URL as referer`, 'info');
    
    const writeStream = fs.createWriteStream(outputPath);
    
    let lastLoggedProgress = 0;
    
    ytdl(`https://www.youtube.com/watch?v=${videoId}`, {
      quality: 'highest',
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36',
          'Referer': embedUrl
        }
      }
    })
    .on('progress', (_, downloaded, total) => {
      if (total) {
        const percent = Math.floor(downloaded / total * 100);
        
        // Only log every 10% to avoid console spam
        if (percent >= lastLoggedProgress + 10 || percent === 100) {
          log(`Download progress: ${percent}%`, 'info');
          lastLoggedProgress = percent;
        }
      }
    })
    .on('end', () => {
      const stats = fs.statSync(outputPath);
      const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      
      log(`METHOD 4 SUCCESSFUL: Embed URL download completed`, 'success');
      log(`Video saved to: ${path.basename(outputPath)} (${fileSizeMB} MB)`, 'success');
    })
    .on('error', (err) => {
      log(`Embed URL download error: ${err}`, 'error');
    })
    .pipe(writeStream);
    
    return new Promise(resolve => {
      writeStream.on('finish', () => {
        // Check if the file has content (size > 0)
        const stats = fs.statSync(outputPath);
        if (stats.size > 0) {
          resolve(true);
        } else {
          log(`Embed URL download failed: Output file is empty`, 'error');
          resolve(false);
        }
      });
      writeStream.on('error', (err) => {
        log(`Embed URL write error: ${err}`, 'error');
        resolve(false);
      });
    });
  } catch (error) {
    log(`Embed URL download exception: ${error}`, 'error');
    return false;
  }
}

/**
 * Method 5: Download YouTube video as audio only (more likely to succeed)
 */
async function downloadAsAudioOnly(url: string, outputPath: string, videoId: string): Promise<boolean> {
  try {
    log('🔄 METHOD 5: Attempting audio-only download...', 'info');
    
    const audioPath = outputPath.replace('.mp4', '.mp3');
    const writeStream = fs.createWriteStream(audioPath);
    
    log(`Audio will be saved to: ${path.basename(audioPath)}`, 'info');
    
    let lastLoggedProgress = 0;
    
    ytdl(url, {
      quality: 'highestaudio',
      filter: 'audioonly',
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36',
        }
      }
    })
    .on('progress', (_, downloaded, total) => {
      if (total) {
        const percent = Math.floor(downloaded / total * 100);
        
        // Only log every 10% to avoid console spam
        if (percent >= lastLoggedProgress + 10 || percent === 100) {
          log(`Audio download progress: ${percent}%`, 'info');
          lastLoggedProgress = percent;
        }
      }
    })
    .on('end', () => {
      log(`Audio download pipeline completed`, 'info');
    })
    .on('error', (err) => {
      log(`Audio download error: ${err}`, 'error');
    })
    .pipe(writeStream);
    
    return new Promise(resolve => {
      writeStream.on('finish', () => {
        // Check if the audio file has content
        if (fs.existsSync(audioPath)) {
          const stats = fs.statSync(audioPath);
          const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
          
          if (stats.size > 0) {
            log(`METHOD 5 SUCCESSFUL: Audio-only download completed`, 'success');
            log(`Audio saved to: ${path.basename(audioPath)} (${fileSizeMB} MB)`, 'success');
            
            // Create a note file to indicate audio-only download
            const notePath = path.join(DOWNLOAD_DIR, `NOTE-${path.basename(outputPath, '.mp4')}.txt`);
            const noteContent = `Only audio was successfully downloaded due to restrictions.\nThe audio file is available at: ${path.basename(audioPath)}\nFile size: ${fileSizeMB} MB\nDownloaded on: ${new Date().toISOString()}`;
            fs.writeFileSync(notePath, noteContent);
            
            resolve(true);
          } else {
            log(`Audio download failed: Output file is empty`, 'error');
            resolve(false);
          }
        } else {
          log(`Audio download failed: Output file does not exist`, 'error');
          resolve(false);
        }
      });
      writeStream.on('error', (err) => {
        log(`Audio write error: ${err}`, 'error');
        resolve(false);
      });
    });
  } catch (error) {
    log(`Audio download exception: ${error}`, 'error');
    return false;
  }
}

/**
 * Route to download a YouTube video with cookies and anti-bot-detection techniques
 */
app.post('/api/download', async (req: Request, res: Response) => {
  try {
    log(`📥 Received download request: ${JSON.stringify(req.body)}`);
    const { url, quality = 'highest' } = req.body;
    
    if (!url) {
      log(`Bad request: Video URL is required`, 'error');
      return res.status(400).json({ error: 'Video URL is required' });
    }

    // Extract video ID
    const videoId = extractVideoId(url);
    if (!videoId) {
      log(`Bad request: Invalid YouTube URL: ${url}`, 'error');
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    log(`🎬 Processing video ID: ${videoId}`);

    // Replace with your actual API key from environment variables
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      log(`Server configuration error: YouTube API key is not set`, 'error');
      return res.status(500).json({ error: 'Server configuration error: API key missing' });
    }
    
    // Get video details
    const videoDetails = await getVideoDetails(videoId, apiKey);
    if (!videoDetails) {
      log(`Video not found or API key invalid for ID: ${videoId}`, 'error');
      return res.status(404).json({ error: 'Video not found or API key invalid' });
    }

    // Generate safe filename from video title
    const safeTitle = videoDetails.snippet.title
      .replace(/[^\w\s]/gi, '')
      .replace(/\s+/g, '_');
    
    const filename = `${safeTitle}-${videoId}.mp4`;
    const outputPath = path.join(DOWNLOAD_DIR, filename);
    
    log(`Video title: "${videoDetails.snippet.title}"`);
    log(`Channel: ${videoDetails.snippet.channelTitle}`);
    log(`Output filename: ${filename}`);

    // Check if file already exists
    if (fs.existsSync(outputPath)) {
      const stats = fs.statSync(outputPath);
      const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      
      log(`Video already exists: ${filename} (${fileSizeMB} MB)`, 'success');
      
      return res.status(200).json({
        message: 'Video already downloaded',
        videoDetails: {
          id: videoId,
          title: videoDetails.snippet.title,
          channel: videoDetails.snippet.channelTitle,
          views: videoDetails.statistics.viewCount,
        },
        downloadUrl: `/downloads/${filename}`,
        fileSize: `${fileSizeMB} MB`
      });
    }

    // Start download process
    log(`🚀 Starting download for: "${videoDetails.snippet.title}"`, 'info');
    
    // Check for cookies file
    const hasCookies = hasCookiesFile();
    log(`Cookies available: ${hasCookies}`);
    
    // Check for yt-dlp
    const hasYtDlp = await isYtDlpInstalled();
    log(`yt-dlp available: ${hasYtDlp}`);
    
    // Send response before starting the download
    res.status(202).json({
      message: 'Download started',
      videoDetails: {
        id: videoId,
        title: videoDetails.snippet.title,
        channel: videoDetails.snippet.channelTitle,
        views: videoDetails.statistics.viewCount,
      },
      downloadUrl: `/downloads/${filename}`,
      usingCookies: hasCookies,
      usingYtDlp: hasYtDlp
    });

    // Start download process in the background
    (async () => {
      try {
        let success = false;
        
        // Method 1: Try with yt-dlp and cookies if available
        if (hasCookies && hasYtDlp) {
          log('======= ATTEMPTING METHOD 1: yt-dlp with cookies =======', 'info');
          success = await downloadWithYtDlpCookies(url, outputPath, videoId);
          log(`Method 1 result: ${success ? 'SUCCESS ✓' : 'FAILED ✗'}`);
        } else {
          log('Skipping Method 1: Cookies or yt-dlp not available');
        }
        
        // Method 2: Try with enhanced ytdl-core if Method 1 failed or unavailable
        if (!success) {
          log('======= ATTEMPTING METHOD 2: Enhanced ytdl-core =======', 'info');
          success = await downloadWithEnhancedYtdl(url, outputPath, videoId);
          log(`Method 2 result: ${success ? 'SUCCESS ✓' : 'FAILED ✗'}`);
        }
        
        // Method 3: Try with proxy fetch if Method 2 failed
        if (!success) {
          log('======= ATTEMPTING METHOD 3: Proxy fetch =======', 'info');
          success = await downloadWithProxyFetch(url, outputPath, videoId);
          log(`Method 3 result: ${success ? 'SUCCESS ✓' : 'FAILED ✗'}`);
        }
        
        // Method 4: Try with embed URL if Method 3 failed
        if (!success) {
          log('======= ATTEMPTING METHOD 4: Embed URL =======', 'info');
          success = await downloadWithEmbedURL(videoId, outputPath);
          log(`Method 4 result: ${success ? 'SUCCESS ✓' : 'FAILED ✗'}`);
        }
        
        // Method 5: Try audio-only as last resort
        if (!success) {
          log('======= ATTEMPTING METHOD 5: Audio-only download =======', 'info');
          success = await downloadAsAudioOnly(url, outputPath, videoId);
          log(`Method 5 result: ${success ? 'SUCCESS ✓' : 'FAILED ✗'}`);
        }
        
        if (!success) {
          log('❌ ALL DOWNLOAD METHODS FAILED', 'error');
          
          // Create an error file to indicate the download failed
          const errorPath = path.join(DOWNLOAD_DIR, `ERROR-${safeTitle}-${videoId}.txt`);
          const errorContent = `Download failed: All methods were unsuccessful. 
YouTube may be blocking server access.

Video Information:
- Title: ${videoDetails.snippet.title}
- Channel: ${videoDetails.snippet.channelTitle}
- Video ID: ${videoId}
- URL: ${url}
- Attempted on: ${new Date().toISOString()}

Things to try:
1. Export fresh cookies from a different browser
2. Use a VPN or different network
3. Download the video locally and upload it to the server
4. Check for alternative sources like British Pathé's website`;

          fs.writeFileSync(errorPath, errorContent);
          log(`Created error file: ${errorPath}`);
        } else {
          // Additional check to make sure file exists and has content
          if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
            const stats = fs.statSync(outputPath);
            const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
            
            log(`🎉 DOWNLOAD COMPLETED SUCCESSFULLY`, 'success');
            log(`Final file: ${path.basename(outputPath)} (${fileSizeMB} MB)`, 'success');
          } else {
            // Audio-only case may have already been handled
            const audioPath = outputPath.replace('.mp4', '.mp3');
            if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 0) {
              const stats = fs.statSync(audioPath);
              const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
              
              log(`🎵 AUDIO-ONLY DOWNLOAD COMPLETED SUCCESSFULLY`, 'success');
              log(`Audio file: ${path.basename(audioPath)} (${fileSizeMB} MB)`, 'success');
            } else {
              log(`❓ Download process completed with success flag but no output file found`, 'warn');
            }
          }
        }
      } catch (error) {
        log(`❌ Unhandled error in download process: ${error}`, 'error');
      }
    })();
  } catch (error) {
    log(`Download request error: ${error}`, 'error');
    res.status(500).json({ error: 'Server error during download' });
  }
});

/**
 * Route to get download status
 */
app.get('/api/status', (req: Request, res: Response) => {
  try {
    log('Received request for download status');
    
    const files = fs.readdirSync(DOWNLOAD_DIR);
    const downloads = files.map(file => {
      const filePath = path.join(DOWNLOAD_DIR, file);
      const stats = fs.statSync(filePath);
      
      // Extract video ID from filename if possible
      let videoId = null;
      const idMatch = file.match(/-([a-zA-Z0-9_-]{11})\.(mp4|mp3|txt)$/);
      if (idMatch) {
        videoId = idMatch[1];
      }
      
      return {
        filename: file,
        size: stats.size,
        sizeInMB: (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
        createdAt: stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString(),
        downloadUrl: `/downloads/${file}`,
        isError: file.startsWith('ERROR-'),
        isNote: file.startsWith('NOTE-'),
        videoId: videoId
      };
    });
    
    // Check cookies file status
    const cookiesStatus = {
      exists: fs.existsSync(COOKIES_FILE),
      path: COOKIES_FILE,
      lastUpdated: fs.existsSync(COOKIES_FILE) 
        ? fs.statSync(COOKIES_FILE).mtime.toISOString()
        : null
    };
    
    // Count successful downloads vs errors
    const successCount = downloads.filter(d => !d.isError && !d.isNote && (d.filename.endsWith('.mp4') || d.filename.endsWith('.mp3'))).length;
    const errorCount = downloads.filter(d => d.isError).length;
    const audioOnlyCount = downloads.filter(d => d.isNote || d.filename.endsWith('.mp3')).length;
    
    log(`Status request: ${downloads.length} files, ${successCount} successful, ${errorCount} errors, ${audioOnlyCount} audio-only`);
    
    res.json({ 
      downloads,
      totalFiles: downloads.length,
      totalSize: downloads.reduce((acc, file) => acc + parseFloat(file.sizeInMB) || 0, 0).toFixed(2) + ' MB',
      cookiesStatus,
      stats: {
        successCount,
        errorCount,
        audioOnlyCount
      }
    });
  } catch (error) {
    log(`Error getting download status: ${error}`, 'error');
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * Route to check if cookies file exists
 */
app.get('/api/cookies-status', (req: Request, res: Response) => {
  try {
    const exists = fs.existsSync(COOKIES_FILE);
    const stats = exists ? fs.statSync(COOKIES_FILE) : null;
    
    log(`Cookies status check: ${exists ? 'Found' : 'Not found'}`);
    
    res.json({
      exists,
      path: COOKIES_FILE,
      size: stats ? stats.size : null,
      sizeInKB: stats ? (stats.size / 1024).toFixed(2) + ' KB' : null,
      lastUpdated: stats ? stats.mtime.toISOString() : null,
      createdAt: stats ? stats.birthtime.toISOString() : null
    });
  } catch (error) {
    log(`Error checking cookies: ${error}`, 'error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Start the server
app.listen(port, () => {
  console.log('='.repeat(50));
  log(`🚀 YouTube downloader API running on port ${port}`, 'success');
  log(`📁 Downloads available at: http://localhost:${port}/downloads/`);
  log(`🔧 Server running in ${process.env.NODE_ENV || 'production'} mode`);
  console.log('='.repeat(50));
  
  // Check for cookies file on startup
  if (fs.existsSync(COOKIES_FILE)) {
    const stats = fs.statSync(COOKIES_FILE);
    log(`🍪 Found cookies file: ${COOKIES_FILE} (${(stats.size / 1024).toFixed(2)} KB)`, 'success');
    log(`Cookies last updated: ${stats.mtime.toISOString()}`);
  } else {
    log(`⚠️ No cookies file found at: ${COOKIES_FILE}`, 'warn');
    log('To enable cookie authentication, place a cookies.txt file in the root directory.');
  }
  console.log('='.repeat(50));
});