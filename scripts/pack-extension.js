const fs = require('fs');
const path = require('path');
function removeIfExists(filePath) {
    if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { recursive: true, force: true });
    }
}

function main() {
    const rootDir = path.resolve(__dirname, '..');
    const distDir = path.join(rootDir, 'dist');

    fs.mkdirSync(distDir, { recursive: true });

    const keyPath = path.join(distDir, 'YT下载器 浏览器插件.pem');
    const crxPath = path.join(distDir, 'YT下载器 浏览器插件.crx');
    const zipPath = path.join(distDir, 'YT下载器 浏览器插件.zip');
    const staleDir = path.join(distDir, 'YT下载器 浏览器插件');
    const generatedCrx = path.join(rootDir, 'browser-extension.crx');
    const generatedPem = path.join(rootDir, 'browser-extension.pem');

    removeIfExists(staleDir);
    removeIfExists(zipPath);
    removeIfExists(crxPath);
    removeIfExists(keyPath);
    removeIfExists(generatedCrx);
    removeIfExists(generatedPem);

    console.log('已清理扩展打包产物');
}

try {
    main();
} catch (error) {
    console.error(error);
    process.exit(1);
}
