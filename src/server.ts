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
}

// Configure middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
    console.log(`Found cookies file: ${COOKIES_FILE}`);
  } else {
    console.log(`No cookies file found at: ${COOKIES_FILE}`);
  }
  return exists;
}

/**
 * Check if yt-dlp is installed
 */
async function isYtDlpInstalled(): Promise<boolean> {
  try {
    await execAsync('yt-dlp --version');
    console.log('yt-dlp is installed');
    return true;
  } catch (error) {
    console.log('yt-dlp is not installed');
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
      console.error('Video not found');
      return null;
    }

    return response.data.items[0];
  } catch (error) {
    console.error('Error fetching video details:', error);
    return null;
  }
}

/**
 * Method 1: Download with yt-dlp using cookies
 */
async function downloadWithYtDlpCookies(url: string, outputPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    console.log('Attempting download with yt-dlp using cookies...');
    
    // Check if cookies file exists
    if (!fs.existsSync(COOKIES_FILE)) {
      console.log('Cookies file not found. Skipping this method.');
      resolve(false);
      return;
    }
    
    const args = [
      '--cookies', COOKIES_FILE,
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36',
      '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--output', outputPath,
      url
    ];
    
    const ytdlp = spawn('yt-dlp', args);
    
    ytdlp.stdout.on('data', (data) => {
      const output = data.toString().trim();
      console.log(`yt-dlp: ${output}`);
    });
    
    ytdlp.stderr.on('data', (data) => {
      const error = data.toString().trim();
      console.error(`yt-dlp error: ${error}`);
    });
    
    ytdlp.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        console.log('yt-dlp with cookies download completed successfully!');
        resolve(true);
      } else {
        console.log(`yt-dlp exited with code ${code}`);
        resolve(false);
      }
    });
  });
}

/**
 * Method 2: Download video using ytdl-core with enhanced options to avoid bot detection
 */
async function downloadWithEnhancedYtdl(url: string, outputPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      console.log('Attempting download with enhanced ytdl-core settings...');
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
      
      ytdl(url, options)
      .on('progress', (_, downloaded, total) => {
        if (total) {
          const percent = (downloaded / total * 100).toFixed(2);
          process.stdout.write(`Progress: ${percent}%\r`);
        }
      })
      .on('end', () => {
        console.log('\nEnhanced ytdl-core download completed');
        resolve(true);
      })
      .on('error', (err) => {
        console.error('Enhanced ytdl-core download error:', err);
        resolve(false);
      })
      .pipe(writeStream);
    } catch (error) {
      console.error('Enhanced ytdl-core download exception:', error);
      resolve(false);
    }
  });
}

/**
 * Method 3: Download using direct fetch with proxy
 */
async function downloadWithProxyFetch(url: string, outputPath: string): Promise<boolean> {
  try {
    console.log('Attempting download with proxy fetch...');
    
    // Attempt to get the video info first
    const info = await ytdl.getInfo(url, {
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36',
        }
      }
    });
    
    const format = ytdl.chooseFormat(info.formats, { quality: 'highest' });
    
    if (!format || !format.url) {
      console.error('Could not get direct video URL');
      return false;
    }
    
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
    
    // Pipe the response to the file
    const writer = fs.createWriteStream(tempFilePath);
    
    response.data.pipe(writer);
    
    return new Promise((resolve) => {
      writer.on('finish', () => {
        // Move the temp file to the actual output path
        fs.renameSync(tempFilePath, outputPath);
        console.log('Proxy fetch download completed');
        resolve(true);
      });
      
      writer.on('error', (err) => {
        console.error('Proxy fetch download error:', err);
        resolve(false);
      });
    });
  } catch (error) {
    console.error('Proxy fetch download exception:', error);
    return false;
  }
}

/**
 * Method 4: Download using a YouTube embed URL
 */
async function downloadWithEmbedURL(videoId: string, outputPath: string): Promise<boolean> {
  try {
    console.log('Attempting download with embed URL...');
    
    // YouTube embed URLs sometimes have different rate limiting
    const embedUrl = `https://www.youtube.com/embed/${videoId}`;
    
    // First get the embed page
    const embedResponse = await axios.get(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36',
      }
    });
    
    // This is a simplified example - in reality, we would need to parse the embed page
    // to find the video URL, which is not straightforward
    
    // For now, we'll use ytdl-core with the embed URL as a workaround
    const writeStream = fs.createWriteStream(outputPath);
    
    ytdl(`https://www.youtube.com/watch?v=${videoId}`, {
      quality: 'highest',
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36',
          'Referer': embedUrl
        }
      }
    })
    .on('end', () => {
      console.log('Embed URL download completed');
    })
    .on('error', (err) => {
      console.error('Embed URL download error:', err);
    })
    .pipe(writeStream);
    
    return new Promise(resolve => {
      writeStream.on('finish', () => {
        resolve(true);
      });
      writeStream.on('error', () => {
        resolve(false);
      });
    });
  } catch (error) {
    console.error('Embed URL download exception:', error);
    return false;
  }
}

/**
 * Method 5: Download YouTube video as audio only (more likely to succeed)
 */
async function downloadAsAudioOnly(url: string, outputPath: string): Promise<boolean> {
  try {
    console.log('Attempting audio-only download...');
    const audioPath = outputPath.replace('.mp4', '.mp3');
    const writeStream = fs.createWriteStream(audioPath);
    
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
        const percent = (downloaded / total * 100).toFixed(2);
        process.stdout.write(`Audio progress: ${percent}%\r`);
      }
    })
    .on('end', () => {
      console.log('\nAudio download completed');
    })
    .on('error', (err) => {
      console.error('Audio download error:', err);
    })
    .pipe(writeStream);
    
    return new Promise(resolve => {
      writeStream.on('finish', () => {
        // Create a note file to indicate audio-only download
        const notePath = path.join(DOWNLOAD_DIR, `NOTE-${path.basename(outputPath, '.mp4')}.txt`);
        fs.writeFileSync(notePath, 'Only audio was successfully downloaded due to restrictions. The audio file is available at: ' + path.basename(audioPath));
        resolve(true);
      });
      writeStream.on('error', () => {
        resolve(false);
      });
    });
  } catch (error) {
    console.error('Audio download exception:', error);
    return false;
  }
}

/**
 * Route to download a YouTube video with cookies and anti-bot-detection techniques
 */
app.post('/api/download', async (req: Request, res: Response) => {
  try {
    console.log('Received download request:', req.body);
    const { url, quality = 'highest' } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'Video URL is required' });
    }

    // Extract video ID
    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    console.log(`Processing video ID: ${videoId}`);

    // Replace with your actual API key from environment variables
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      console.error('YouTube API key is not set in environment variables');
      return res.status(500).json({ error: 'Server configuration error: API key missing' });
    }
    
    // Get video details
    const videoDetails = await getVideoDetails(videoId, apiKey);
    if (!videoDetails) {
      return res.status(404).json({ error: 'Video not found or API key invalid' });
    }

    // Generate safe filename from video title
    const safeTitle = videoDetails.snippet.title
      .replace(/[^\w\s]/gi, '')
      .replace(/\s+/g, '_');
    
    const filename = `${safeTitle}-${videoId}.mp4`;
    const outputPath = path.join(DOWNLOAD_DIR, filename);

    // Check if file already exists
    if (fs.existsSync(outputPath)) {
      return res.status(200).json({
        message: 'Video already downloaded',
        videoDetails: {
          id: videoId,
          title: videoDetails.snippet.title,
          channel: videoDetails.snippet.channelTitle,
          views: videoDetails.statistics.viewCount,
        },
        downloadUrl: `/downloads/${filename}`
      });
    }

    // Start download process
    console.log(`Starting download: ${videoDetails.snippet.title}`);
    
    // Check for cookies file
    const hasCookies = hasCookiesFile();
    
    // Check for yt-dlp
    const hasYtDlp = await isYtDlpInstalled();
    
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
          console.log('Trying yt-dlp with cookies (Method 1)...');
          success = await downloadWithYtDlpCookies(url, outputPath);
        }
        
        // Method 2: Try with enhanced ytdl-core if Method 1 failed or unavailable
        if (!success) {
          console.log('Method 1 unavailable or failed, trying enhanced ytdl-core (Method 2)...');
          success = await downloadWithEnhancedYtdl(url, outputPath);
        }
        
        // Method 3: Try with proxy fetch if Method 2 failed
        if (!success) {
          console.log('Method 2 failed, trying proxy fetch (Method 3)...');
          success = await downloadWithProxyFetch(url, outputPath);
        }
        
        // Method 4: Try with embed URL if Method 3 failed
        if (!success) {
          console.log('Method 3 failed, trying embed URL (Method 4)...');
          success = await downloadWithEmbedURL(videoId, outputPath);
        }
        
        // Method 5: Try audio-only as last resort
        if (!success) {
          console.log('Method 4 failed, trying audio-only download (Method 5)...');
          success = await downloadAsAudioOnly(url, outputPath);
        }
        
        if (!success) {
          console.error('All download methods failed');
          // Create an error file to indicate the download failed
          const errorPath = path.join(DOWNLOAD_DIR, `ERROR-${safeTitle}-${videoId}.txt`);
          fs.writeFileSync(errorPath, `Download failed: All methods were unsuccessful. 
YouTube may be blocking server access.

Things to try:
1. Export fresh cookies from a different browser
2. Use a VPN or different network
3. Download the video locally and upload it to the server
4. Check for alternative sources like British Pathé's website`);
        }
      } catch (error) {
        console.error('Error in download process:', error);
      }
    })();
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Server error during download' });
  }
});

/**
 * Route to get download status
 */
app.get('/api/status', (req: Request, res: Response) => {
  try {
    const files = fs.readdirSync(DOWNLOAD_DIR);
    const downloads = files.map(file => {
      const filePath = path.join(DOWNLOAD_DIR, file);
      const stats = fs.statSync(filePath);
      return {
        filename: file,
        size: stats.size,
        sizeInMB: (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
        createdAt: stats.birthtime.toISOString(),
        downloadUrl: `/downloads/${file}`,
        isError: file.startsWith('ERROR-'),
        isNote: file.startsWith('NOTE-')
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
    
    res.json({ 
      downloads,
      totalFiles: downloads.length,
      totalSize: downloads.reduce((acc, file) => acc + parseFloat(file.sizeInMB) || 0, 0).toFixed(2) + ' MB',
      cookiesStatus
    });
  } catch (error) {
    console.error('Error getting download status:', error);
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
    
    res.json({
      exists,
      path: COOKIES_FILE,
      size: stats ? stats.size : null,
      lastUpdated: stats ? stats.mtime.toISOString() : null
    });
  } catch (error) {
    console.error('Error checking cookies:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`YouTube downloader API running on port ${port}`);
  console.log(`Downloads available at: http://localhost:${port}/downloads/`);
  console.log(`Server running in ${process.env.NODE_ENV || 'production'} mode`);
  console.log(`Server includes anti-bot detection measures`);
  
  // Check for cookies file on startup
  if (fs.existsSync(COOKIES_FILE)) {
    console.log(`Found cookies file: ${COOKIES_FILE}`);
  } else {
    console.log(`No cookies file found at: ${COOKIES_FILE}`);
    console.log('To enable cookie authentication, place a cookies.txt file in the root directory.');
  }
});