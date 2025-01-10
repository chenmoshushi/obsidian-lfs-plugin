import AuthenticatedImgurClient from '../../imgur/AuthenticatedImgurClient'
import ImageUploader from '../ImageUploader'
import { MarkdownFileInfo } from 'obsidian'
import { ImageURL } from '../../utils/types'

export default class ImgurAuthenticatedUploader implements ImageUploader {
  constructor(readonly client: AuthenticatedImgurClient) {}

  async upload(image: File, notePath?: string, albumId?: string): Promise<string> {
    return (await this.client.upload(image, albumId)).data.link
  }

  async download(ctx: MarkdownFileInfo, imageURL: ImageURL): Promise<string> {
    return new Promise(async (resolve, reject) => {
        reject(new Error(`Not Implement!!!`));
    });
  }
}
