export default interface Imageloader {
  upload(image: File, albumId?: string): Promise<string>
}
