export default interface Imageloader {
  upload(image: File, albumId?: string): Promise<string>
  download(imageURL: ImageURL, filePath: string): Promise<string>
}
