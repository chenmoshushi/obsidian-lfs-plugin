import { requestUrl } from 'obsidian'

import { handleImgurErrorResponse } from '../../imgur/AuthenticatedImgurClient'
import { IMGUR_API_BASE } from '../../imgur/constants'
import { ImgurPostData } from '../../imgur/imgurResponseTypes'
import prepareMultipartRequestPiece from '../../utils/obsidian-http-client'
import ImageUploader from '../ImageUploader'
import { sha256 } from 'js-sha256';

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

  async upload(image: File): Promise<string> {
    console.warn("upload: ", image.name);
    const { hash: fileHash, size: fileSize } = await calculateFileOid(image);

    // const lfsPointerContent = generateLfsPointer({ oid: fileHash, size: fileSize });
    // const lfsPointerFilePath = filePath + '.pointer';
    // await fsp.mkdir(dirname(lfsPointerFilePath), { recursive: true });
    // await fsp.writeFile(lfsPointerFilePath, lfsPointerContent);
    // console.warn("lfsPointerFilePath", lfsPointerFilePath);

    const lfsInitData = {
        operation: 'upload',
        transfers: ['basic', 'ssh'],
        objects: [
            {
                oid: fileHash,
                size: fileSize,
                file_path: image.name
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
                    'x-file-path': image.name
                },
                body: await fileDataPromise
            });
            console.warn("uploadResponse", uploadResponse);
            if (uploadResponse.status >= 400) {
                handleImgurErrorResponse(initResponse)
            }
        } else {
            console.warn("no need actions");
        }
    } catch (e) {
        console.error("Upload Error: ", e);
    }
    return basename(image.name);
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
    const parts = path.split('/');
    let filename = parts.pop() || '';
    if (ext && filename.endsWith(ext)) {
        filename = filename.slice(0, -ext.length);
    }
    return filename;
}
