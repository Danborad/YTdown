const { isIP } = require('net');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CDN_HOST = 'cms-public-artifacts.artlist.io';
const CDN_BASE = `https://${CDN_HOST}/`;
const AUDIO_EXTENSIONS = ['.aac', '.mp3', '.m4a', '.wav', '.ogg', '.flac', '.opus'];

function isArtlistUrl(value) {
    try {
        const parsed = new URL(String(value || '').trim());
        const hostname = parsed.hostname.toLowerCase();
        return parsed.protocol === 'https:' && (hostname === 'artlist.io' || hostname.endsWith('.artlist.io'));
    } catch (error) {
        return false;
    }
}

function unescapeText(value) {
    return String(value || '')
        .replace(/\\\//g, '/')
        .replace(/\\u0026/gi, '&')
        .replace(/\\u002f/gi, '/')
        .replace(/\\u003d/gi, '=')
        .replace(/\\u0025/gi, '%')
        .replace(/\\"/g, '"')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#x27;/gi, "'")
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>');
}

function extractBalancedObject(text, openBraceIndex) {
    if (openBraceIndex < 0 || text[openBraceIndex] !== '{') return '';

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = openBraceIndex; index < text.length; index += 1) {
        const character = text[index];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (character === '\\') {
                escaped = true;
            } else if (character === '"') {
                inString = false;
            }
            continue;
        }

        if (character === '"') {
            inString = true;
        } else if (character === '{') {
            depth += 1;
        } else if (character === '}') {
            depth -= 1;
            if (depth === 0) return text.slice(openBraceIndex, index + 1);
        }
    }
    return '';
}

function parseJsonCandidate(raw) {
    const candidates = [raw, unescapeText(raw)];
    for (const candidate of candidates) {
        try {
            const data = JSON.parse(candidate);
            if (data && typeof data === 'object') return data;
        } catch (error) {
            // Next.js flight payloads can contain multiple escaping layers.
        }
    }
    return null;
}

function findField(html, fieldName) {
    const escapedName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:\\\\"|")${escapedName}(?:\\\\"|")\\s*:\\s*(?:\\\\"|")((?:\\\\.|[^"\\\\])+?)(?:\\\\"|")`, 'i');
    const match = html.match(pattern);
    return match ? unescapeText(match[1]).trim() : '';
}

function extractArtlistSongData(html) {
    const source = String(html || '');
    const songDataPattern = /(?:\\\\"|")songData(?:\\\\"|")\s*:\s*\{/gi;
    let match;
    while ((match = songDataPattern.exec(source))) {
        const braceIndex = source.indexOf('{', match.index);
        const raw = extractBalancedObject(source, braceIndex);
        const data = parseJsonCandidate(raw);
        if (data && (data.sitePlayableFilePath || data.songName || data.songId)) return data;
    }

    const playablePath = findField(source, 'sitePlayableFilePath');
    if (!playablePath) return null;
    return {
        sitePlayableFilePath: playablePath,
        songName: findField(source, 'songName'),
        artistName: findField(source, 'artistName'),
        songId: findField(source, 'songId')
    };
}

function resolvePlayablePath(value) {
    const raw = unescapeText(value).trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith('content/') || raw.startsWith('/content/')) {
        return new URL(raw.replace(/^\/+/, ''), CDN_BASE).toString();
    }

    try {
        const decoded = Buffer.from(raw + '='.repeat((4 - (raw.length % 4)) % 4), 'base64').toString('utf8');
        if (decoded.includes('content/') || AUDIO_EXTENSIONS.some((extension) => decoded.toLowerCase().endsWith(extension))) {
            return /^https?:\/\//i.test(decoded)
                ? decoded
                : new URL(decoded.replace(/^\/+/, ''), CDN_BASE).toString();
        }
    } catch (error) {
        // The CDN also accepts an opaque base64 path.
    }
    return new URL(raw.replace(/^\/+/, ''), CDN_BASE).toString();
}

function cleanTitle(value, fallback = 'artlist_audio') {
    return unescapeText(value)
        .replace(/\s*[|\-–—]\s*Artlist.*$/i, '')
        .replace(/\s+by\s+.+$/i, '')
        .replace(/\s+on Artlist.*$/i, '')
        .replace(/\s+/g, ' ')
        .trim() || fallback;
}

function isSafeArtlistImageUrl(value) {
    try {
        const parsed = new URL(String(value || ''));
        const hostname = parsed.hostname.toLowerCase();
        return parsed.protocol === 'https:' && (
            hostname === 'artlist-albums.imgix.net'
            || hostname === 'artlist.io'
            || hostname.endsWith('.artlist.io')
        );
    } catch (error) {
        return false;
    }
}

function scoreArtlistThumbnail(url) {
    const value = String(url || '').toLowerCase();
    let score = 0;
    if (value.includes('_image_') || value.includes('/image_')) score += 100;
    if (value.includes('_thumbnail_') || value.includes('/thumbnail_')) score += 80;
    if (/_a\.(?:jpe?g|webp)(?:\?|$)/i.test(value)) score += 70;
    if (/_a_-_thum\.(?:jpe?g|webp)(?:\?|$)/i.test(value)) score += 50;
    if (value.includes('album')) score += 20;
    if (value.includes('_artist_cover_') || value.includes('artist_cover')) score -= 200;
    if (value.includes('banner') || value.includes('hero')) score -= 80;
    if (/\.(jpe?g|webp)(\?|$)/i.test(value)) score += 10;
    if (/\.png(\?|$)/i.test(value) && value.includes('artist_cover')) score -= 50;
    return score;
}

function collectArtlistImageUrls(html) {
    const source = String(html || '');
    const found = [];
    const seen = new Set();
    const add = (raw) => {
        const imageUrl = unescapeText(raw || '').trim();
        if (!isSafeArtlistImageUrl(imageUrl) || seen.has(imageUrl)) return;
        seen.add(imageUrl);
        found.push(imageUrl);
    };

    for (const key of ['albumImageFilePath', 'albumThumbPath', 'albumImagePath', 'albumCoverPath', 'coverImagePath', 'thumbnailPath', 'imagePath', 'albumImage', 'coverImage', 'thumbnailUrl', 'imageUrl']) {
        const value = findField(source, key);
        if (value && /^https?:\/\//i.test(value)) add(value);
    }

    const metaTags = source.match(/<meta\b[^>]*>/gi) || [];
    for (const tag of metaTags) {
        const keyMatch = tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i);
        if (!keyMatch || !/^(og:image|twitter:image)$/i.test(keyMatch[1])) continue;
        const contentMatch = tag.match(/content\s*=\s*["']([^"']+)["']/i);
        if (contentMatch) add(contentMatch[1]);
    }

    const imgSrcPattern = /(?:src|content)=["'](https?:\/\/artlist-albums\.imgix\.net\/[^"']+)["']/gi;
    let match;
    while ((match = imgSrcPattern.exec(source))) add(match[1]);

    const bareUrlPattern = /https?:\/\/artlist-albums\.imgix\.net\/[\w./%-]+(?:\?[^\s"'<>\\]*)?/gi;
    while ((match = bareUrlPattern.exec(source))) add(match[0]);

    return found;
}

function extractArtlistThumbnail(html) {
    const candidates = collectArtlistImageUrls(html);
    if (candidates.length === 0) return '';

    candidates.sort((left, right) => {
        const scoreDiff = scoreArtlistThumbnail(right) - scoreArtlistThumbnail(left);
        if (scoreDiff !== 0) return scoreDiff;
        return left.length - right.length;
    });

    const best = candidates[0];
    return scoreArtlistThumbnail(best) < 0 ? '' : best;
}

function isSafeArtlistAudioUrl(value) {
    try {
        const parsed = new URL(String(value || ''));
        const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        if (parsed.protocol !== 'https:' || isIP(hostname) || hostname !== CDN_HOST) return false;
        return true;
    } catch (error) {
        return false;
    }
}

function guessArtlistExtension(url, contentType = '') {
    let pathname = '';
    try {
        pathname = new URL(url).pathname.toLowerCase();
    } catch (error) {
        pathname = String(url || '').toLowerCase();
    }
    const pathExtension = AUDIO_EXTENSIONS.find((extension) => pathname.endsWith(extension));
    if (pathExtension) return pathExtension.slice(1);

    const type = String(contentType || '').toLowerCase();
    if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
    if (type.includes('wav')) return 'wav';
    if (type.includes('ogg') || type.includes('opus')) return 'ogg';
    if (type.includes('flac')) return 'flac';
    if (type.includes('mp4') || type.includes('m4a')) return 'm4a';
    return 'aac';
}

function parseArtlistPage(html, pageUrl = '') {
    const song = extractArtlistSongData(html) || {};
    let title = cleanTitle(song.songName || '');
    if (title === 'artlist_audio') {
        try {
            const pathname = decodeURIComponent(new URL(pageUrl).pathname).split('/').filter(Boolean);
            const candidate = pathname.findLast((part) => !/^\d+$/.test(part));
            if (candidate) title = cleanTitle(candidate.replace(/[-_]+/g, ' '));
        } catch (error) {
            // Keep the stable fallback title.
        }
    }

    const audioUrl = resolvePlayablePath(song.sitePlayableFilePath || '');
    if (!isSafeArtlistAudioUrl(audioUrl)) {
        throw new Error('Artlist 页面中未找到有效的试听音频地址');
    }
    return {
        title,
        artist: cleanTitle(song.artistName || '', ''),
        songId: String(song.songId || ''),
        audioUrl,
        thumbnail: extractArtlistThumbnail(html),
        pageUrl
    };
}

module.exports = {
    CDN_HOST,
    USER_AGENT,
    isArtlistUrl,
    extractArtlistSongData,
    resolvePlayablePath,
    parseArtlistPage,
    extractArtlistThumbnail,
    guessArtlistExtension,
    isSafeArtlistAudioUrl
};
