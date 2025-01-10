import { requestUrl, TFile, MarkdownFileInfo } from 'obsidian'

import { handleImgurErrorResponse } from '../../imgur/AuthenticatedImgurClient'
import { IMGUR_API_BASE } from '../../imgur/constants'
import { ImgurPostData } from '../../imgur/imgurResponseTypes'
import prepareMultipartRequestPiece from '../../utils/obsidian-http-client'
import ImageUploader from '../ImageUploader'
import { sha256 } from 'js-sha256';
import { ImageURL } from '../../utils/types'

export default class ImgurAnonymousUploader implements ImageUploader {
  private readonly clientId!: string

  constructor(clientId: string) {
    this.clientId = clientId
  }

  // async upload(image: File): Promise<string> {
  //   const requestData = new FormData()
  //   requestData.append('image', image)

  //   const request = {
  //     url: `${IMGUR_API_BASE}/image`,
  //     method: 'POST',
  //     headers: { Authorization: `Client-ID ${this.clientId}` },
  //     ...(await prepareMultipartRequestPiece(requestData)),
  //     throw: false,
  //   }

  //   const resp = await requestUrl(request)

  //   if (resp.status >= 400) {
  //     handleImgurErrorResponse(resp)
  //   }
  //   return (resp.json as ImgurPostData).data.link
  // }

  async download(ctx: MarkdownFileInfo, imageURL: ImageURL): Promise<string> {
    console.warn("download: ", imageURL);
    const { hash: fileHash, size: fileSize } = getURLOid(imageURL.url);
    const lfsInitData = {
        operation: 'download',
        transfers: ['basic', 'ssh'],
        objects: [
            {
                oid: fileHash,
                size: fileSize,
            }
        ],
        ref: { name: 'refs/heads/main' },
        hash_algo: 'sha256'
    };
    const headers = {
        'Accept': 'application/vnd.git-lfs+json',
        'Content-Type': 'application/vnd.git-lfs+json',
    };

    const initResponse = await requestUrl({
        url: `${this.clientId}`,
        method: 'POST',
        headers: headers,
        body: JSON.stringify(lfsInitData) 
    });

    if (initResponse.status >= 400) {
        handleImgurErrorResponse(initResponse)
    }

    console.warn("initResponse", initResponse);
    try {
        const lfsInitData = initResponse.json;
        if ('actions' in lfsInitData.objects[0]) {
            const lfsDownloadUrl = lfsInitData.objects[0].actions.download.href;
            const token = lfsInitData.objects[0].actions.download.header['lfs-batch-token'];
            const repo = lfsInitData.objects[0].actions.download.header['x-git-repo'];

            const downloadResponse = await requestUrl({
                url: lfsDownloadUrl,
                method: 'GET',
                headers: {
                  ...headers,
                    'lfs-batch-token': token,
                    'x-git-repo': repo,
                    'accept-encoding': 'gzip',
                }
            });
            console.warn("downloadResponse", downloadResponse);
            if (downloadResponse.status >= 400) {
                handleImgurErrorResponse(downloadResponse)
            }

            return new Promise(async (resolve, reject) => {
                try {
                    const arrayBuffer = downloadResponse.arrayBuffer; // 直接访问 arrayBuffer 属性
                    const uint8Array = new Uint8Array(arrayBuffer);
            
                    let totalBytes = 0;
                    const hash = sha256.create();
            
                    const attachPath = (ctx.app.vault as any).getConfig("attachmentFolderPath")
                    console.error(`attachPath=${attachPath}`);
                    const tempFilePath = `${attachPath}/${imageURL.path}.tmp`;
                    let tempFile = ctx.app.vault.getAbstractFileByPath(tempFilePath) as TFile;
                    if (!tempFile) {
                        tempFile = await ctx.app.vault.create(tempFilePath, '');
                    } else {
                        await ctx.app.vault.modify(tempFile, '');
                    }
            
                    // 处理整个 ArrayBuffer
                    hash.update(uint8Array);
                    await ctx.app.vault.adapter.writeBinary(tempFilePath, uint8Array);
                    totalBytes += uint8Array.length;
            
                    const calculatedHash = hash.hex();
                    if (calculatedHash !== fileHash) {
                        reject(new Error(`Download Hash Mismatch: ${calculatedHash} vs ${fileHash}`));
                    } else {
                        console.error("Download ok, Rename..");
                        const newDir = `${attachPath}/${dirname(imageURL.notePath)}/${basename(imageURL.notePath, 'all')}`
                        const newPath = `${newDir}/${imageURL.path}`
                        console.error(`newPath=${newPath}`);

                        const exists = await ctx.app.vault.adapter.exists(newDir, true);
                        if (!exists) {
                            await ctx.app.vault.adapter.mkdir(newDir);
                        }
                        await ctx.app.fileManager.renameFile(tempFile, newPath);
                        resolve(newPath);
                    }
                } catch (e) {
                    console.error("Download error:", e);
                    reject(new Error(`Download Error: ${e.message}`));
                }
            });
        } else {
            console.warn("no need actions");
        }
    } catch (e) {
        console.error("Download Error: ", e);
        throw new Error(`Download Error: ${e.message}`)
    }
  }

  async upload(image: File, notePath?: string, albumId?: string): Promise<string> {
    console.warn("upload: ", image.name);
    const { hash: fileHash, size: fileSize } = await calculateFileOid(image);

    // const lfsPointerContent = generateLfsPointer({ oid: fileHash, size: fileSize });
    // const lfsPointerFilePath = filePath + '.pointer';
    // await fsp.mkdir(dirname(lfsPointerFilePath), { recursive: true });
    // await fsp.writeFile(lfsPointerFilePath, lfsPointerContent);
    // console.warn("lfsPointerFilePath", lfsPointerFilePath);
    const newPath = notePath !== undefined
            ? `${dirname(notePath)}/${basename(notePath, 'all')}/${image.name}`
            : `${image.name}`;
    console.warn("newPath", newPath);
    const lfsInitData = {
        operation: 'upload',
        transfers: ['basic', 'ssh'],
        objects: [
            {
                oid: fileHash,
                size: fileSize,
                file_path: newPath
            }
        ],
        ref: { name: 'refs/heads/main' },
        hash_algo: 'sha256'
    };
    const headers = {
        'Accept': 'application/vnd.git-lfs+json',
        'Content-Type': 'application/vnd.git-lfs+json',
    };

    const initResponse = await requestUrl({
        url: `${this.clientId}`,
        method: 'POST',
        headers: headers,
        body: JSON.stringify(lfsInitData) 
    });

    if (initResponse.status >= 400) {
        handleImgurErrorResponse(initResponse)
    }

    const reader = new FileReader();
    console.warn("initResponse", initResponse);
    try {
        const lfsInitData = initResponse.json;
        if ('actions' in lfsInitData.objects[0]) {
            const lfsUploadUrl = lfsInitData.objects[0].actions.upload.href;
            const token = lfsInitData.objects[0].actions.upload.header['lfs-batch-token'];
            const repo = lfsInitData.objects[0].actions.upload.header['x-git-repo'];
            const fileDataPromise = new Promise<ArrayBuffer>((resolve, reject) => {
                reader.onload = () => {
                    if (reader.result instanceof ArrayBuffer) {
                        resolve(reader.result);
                    } else {
                        reject(new Error('读取文件数据为无效的ArrayBuffer'));
                    }
                };
                reader.onerror = (error) => {
                    reject(error);
                };
                reader.readAsArrayBuffer(image);
            });

            const uploadResponse = await requestUrl({
                url: lfsUploadUrl,
                method: 'PUT',
                headers: {
                  ...headers,
                    'lfs-batch-token': token,
                    'x-git-repo': repo,
                    'accept-encoding': 'gzip',
                    'Content-Type': 'application/octet-stream',
                    'x-file-path': newPath
                },
                body: await fileDataPromise
            });
            console.warn("uploadResponse", uploadResponse);
            if (uploadResponse.status >= 400) {
                handleImgurErrorResponse(uploadResponse)
            }
        } else {
            console.warn("no need actions");
        }
    } catch (e) {
        console.error("Upload Error: ", e);
        throw new Error(`Upload Error: ${e.message}`)
    }
    return `${basename(image.name)}#lfs=${fileHash}^${fileSize}`;
  }
}

async function calculateFileOid(image: File): Promise<{ hash: string; size: number }> {
    return new Promise((resolve, reject) => {
        const hash = sha256.create();
        let size = 0;
        console.error("calculateFileOid: ", image);
        const reader = new FileReader();

        reader.onload = function () {
            if (this.result) {
                let buffer: Uint8Array;
                if (this.result instanceof ArrayBuffer) {
                    buffer = new Uint8Array(this.result);
                } else if (typeof this.result ==='string') {
                    const bufferData = Buffer.from(this.result, 'utf8');
                    buffer = new Uint8Array(bufferData.buffer);
                }
                hash.update(buffer);
                size += buffer.byteLength;
                resolve({
                    hash: hash.hex(),
                    size: size
                });
                // const buffer = new Uint8Array(this.result);
                // hash.update(buffer);
                // size += buffer.byteLength;
                // resolve({
                //     hash: hash.digest('hex'),
                //     size: size
                // });
            }
        };

        reader.onerror = function (err) {
            reject(err);
        };

        reader.readAsArrayBuffer(image);
    });
}

// `${basename(image.name)}#lfs=${fileHash}^${fileSize}`;
function getURLOid(imageURL: string): { hash: string; size: number } {
    const parts = imageURL.split('#');
    const lfsString = parts.pop() || '';
    if (lfsString) {
        const queryParams = lfsString.split('&');
        const lfsParam = queryParams.find(param => param.startsWith('lfs='));
        if (lfsParam) {
            const lfsData = lfsParam.substring(4); // Remove 'lfs='
            const [hash, sizeStr] = lfsData.split('^');

            if (hash && sizeStr) {
                const size = parseInt(sizeStr, 10);
                if (!isNaN(size)) {
                    return { hash, size };
                }
            }
        }
    }
    throw new Error(`Invalid LFS URL: ${imageURL}`)
}

// function generateLfsPointer(oid: fileHash, size: fileSize) {
//     const versionLine = `version https://git-lfs.github.com/spec/v1`;
//     const oidLine = `oid sha256:${oid}`;
//     const sizeLine = `size ${size}`;
//     return `${versionLine}\n${oidLine}\n${sizeLine}`;
// }

function dirname(path: string): string {
    const parts = path.split('/');
    parts.pop();
    return parts.join('/') || '/';
}

function basename(path: string, ext: string = ''): string {
    const parts1 = path.split('/');
    let filename = parts1.pop() || '';
    if (ext && filename.endsWith(ext)) {
        filename = filename.slice(0, -ext.length);
    } else if (ext == 'all' && filename.indexOf('.')>-1) {
        const parts2 = filename.split('.');
        parts2.pop();
        filename = parts2.join('.');
    }
    return filename;
}
