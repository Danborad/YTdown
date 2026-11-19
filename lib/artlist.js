const { isIP } = require('net');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CDN_HOST = 'cms-public-artifacts.artlist.io';
const CDN_BASE = `https://${CDN_HOST}/`;
const ARTLIST_GRAPHQL_ENDPOINTS = [
    'https://search-api.artlist.io/v2/graphql',
    'https://search-api.artlist.io/v1/graphql'
];
const ARTLIST_IMAGE_HOSTS = new Set([
    'artlist-albums.imgix.net',
    'artlist-images.imgix.net',
    'artlist.io'
]);
const AUDIO_EXTENSIONS = ['.aac', '.mp3', '.m4a', '.wav', '.ogg', '.flac', '.opus'];

const SONG_GRAPHQL_QUERY = `query Songs($ids: [String!]!) {
    songs(ids: $ids) {
        songId
        songName
        artistName
        albumName
        albumImageFilePath
        sitePlayableFilePath
    }
}`;

const SFX_GRAPHQL_QUERY = `query Sfxs($ids: [Int!]!) {
    sfxs(ids: $ids) {
        songId
        songName
        artistName
        albumName
        albumImageFilePath
        sitePlayableFilePath
    }
}`;

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

function decodeBase64AudioPath(rawValue) {
    const token = String(rawValue || '').trim().replace(/^\/+/, '');
    if (!token || token.includes('/')) return '';

    try {
        const decoded = Buffer.from(token + '='.repeat((4 - (token.length % 4)) % 4), 'base64').toString('utf8');
        const lower = decoded.toLowerCase();
        if (decoded.includes('content/') || AUDIO_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
            return decoded;
        }
    } catch (error) {
        // Ignore invalid base64 values.
    }
    return '';
}

function resolvePlayablePath(value) {
    const raw = unescapeText(value).trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith('content/') || raw.startsWith('/content/')) {
        return new URL(raw.replace(/^\/+/, ''), CDN_BASE).toString();
    }

    const decoded = decodeBase64AudioPath(raw);
    if (decoded) {
        return /^https?:\/\//i.test(decoded)
            ? decoded
            : new URL(decoded.replace(/^\/+/, ''), CDN_BASE).toString();
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
            ARTLIST_IMAGE_HOSTS.has(hostname)
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

    const imgSrcPattern = /(?:src|content)=["'](https?:\/\/artlist-(?:albums|images)\.imgix\.net\/[^"']+)["']/gi;
    let match;
    while ((match = imgSrcPattern.exec(source))) add(match[1]);

    const bareUrlPattern = /https?:\/\/artlist-(?:albums|images)\.imgix\.net\/[\w./%-]+(?:\?[^\s"'<>\\]*)?/gi;
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
        pathname = new URL(url).pathname;
    } catch (error) {
        pathname = String(url || '');
    }

    const decodedPath = decodeBase64AudioPath(pathname);
    const candidatePath = (decodedPath || pathname).toLowerCase();
    const pathExtension = AUDIO_EXTENSIONS.find((extension) => candidatePath.endsWith(extension));
    if (pathExtension) return pathExtension.slice(1);

    const type = String(contentType || '').toLowerCase();
    if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
    if (type.includes('wav')) return 'wav';
    if (type.includes('ogg') || type.includes('opus')) return 'ogg';
    if (type.includes('flac')) return 'flac';
    if (type.includes('mp4') || type.includes('m4a')) return 'm4a';
    return 'aac';
}

function extractFallbackTitleFromUrl(pageUrl) {
    try {
        const pathname = decodeURIComponent(new URL(pageUrl).pathname).split('/').filter(Boolean);
        const candidate = pathname.findLast((part) => !/^\d+$/.test(part));
        if (candidate) return cleanTitle(candidate.replace(/[-_]+/g, ' '));
    } catch (error) {
        // Keep the stable fallback title.
    }
    return 'artlist_audio';
}

function normalizeArtlistSongRecord(song, pageUrl = '', fallbackThumbnail = '') {
    const record = song && typeof song === 'object' ? song : {};
    let title = cleanTitle(record.songName || '');
    if (title === 'artlist_audio') {
        title = extractFallbackTitleFromUrl(pageUrl);
    }

    const audioUrl = resolvePlayablePath(record.sitePlayableFilePath || '');
    if (!isSafeArtlistAudioUrl(audioUrl)) {
        throw new Error('Artlist 页面中未找到有效的试听音频地址');
    }

    const directThumbnail = unescapeText(record.albumImageFilePath || '').trim();
    const thumbnail = isSafeArtlistImageUrl(directThumbnail) ? directThumbnail : fallbackThumbnail;

    return {
        title,
        artist: cleanTitle(record.artistName || '', ''),
        songId: String(record.songId || ''),
        audioUrl,
        thumbnail,
        pageUrl
    };
}

function parseArtlistPage(html, pageUrl = '') {
    const song = extractArtlistSongData(html) || {};
    return normalizeArtlistSongRecord(song, pageUrl, extractArtlistThumbnail(html));
}

function extractArtlistTrackInfo(pageUrl) {
    try {
        const parsed = new URL(String(pageUrl || '').trim());
        const pathname = decodeURIComponent(parsed.pathname);
        if (
            /\/(?:stock-footage|video|templates|plugins|lut|ai-voice|album|artist|playlist|collection)\b/i.test(pathname)
            && !/\/(?:song|sfx)\b/i.test(pathname)
        ) {
            return null;
        }

        const segments = pathname.split('/').filter(Boolean);
        const id = segments.findLast((part) => /^\d+$/.test(part));
        if (!id) return null;

        const isSfx = /\/sfx\b/i.test(pathname);
        return {
            id,
            primaryKind: isSfx ? 'sfx' : 'song',
            fallbackKind: isSfx ? 'song' : 'sfx'
        };
    } catch (error) {
        return null;
    }
}

function buildArtlistGraphqlRequest(kind, id) {
    if (kind === 'sfx') {
        const numericId = Number(id);
        if (!Number.isSafeInteger(numericId) || numericId <= 0) {
            throw new Error('无效的 Artlist 音效 ID');
        }
        return {
            query: SFX_GRAPHQL_QUERY,
            variables: { ids: [numericId] }
        };
    }

    return {
        query: SONG_GRAPHQL_QUERY,
        variables: { ids: [String(id)] }
    };
}

function parseArtlistGraphqlResponse(payload, kind, pageUrl = '') {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Artlist 接口返回格式无效');
    }

    const list = kind === 'sfx' ? payload.data?.sfxs : payload.data?.songs;
    if (Array.isArray(list) && list.length > 0) {
        return normalizeArtlistSongRecord(list[0], pageUrl);
    }

    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
        const message = payload.errors[0]?.message || 'Artlist 接口查询失败';
        throw new Error(message);
    }

    return null;
}

module.exports = {
    CDN_HOST,
    USER_AGENT,
    ARTLIST_GRAPHQL_ENDPOINTS,
    isArtlistUrl,
    extractArtlistSongData,
    extractArtlistTrackInfo,
    buildArtlistGraphqlRequest,
    parseArtlistGraphqlResponse,
    resolvePlayablePath,
    parseArtlistPage,
    extractArtlistThumbnail,
    guessArtlistExtension,
    isSafeArtlistAudioUrl
};
