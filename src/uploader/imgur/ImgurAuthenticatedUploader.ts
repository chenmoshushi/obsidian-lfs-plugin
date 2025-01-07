import AuthenticatedImgurClient from '../../imgur/AuthenticatedImgurClient'
import ImageUploader from '../ImageUploader'

export default class ImgurAuthenticatedUploader implements ImageUploader {
  constructor(readonly client: AuthenticatedImgurClient) {}

  async upload(image: File, albumId?: string): Promise<string> {
    return (await this.client.upload(image, albumId)).data.link
  }

  async download(imageURL: ImageURL): Promise<string> {
    return new Promise(async (resolve, reject) => {
        reject(new Error(`Not Implement!!!`));
    });
  }
}
