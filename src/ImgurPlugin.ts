import {
  CanvasView,
  Editor,
  EditorPosition,
  MarkdownFileInfo,
  parseLinktext,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  ReferenceCache,
  TFile,
} from 'obsidian'

import { createImgurCanvasPasteHandler } from './Canvas'
import UploadStrategy from './UploadStrategy'
import DragEventCopy from './aux-event-classes/DragEventCopy'
import PasteEventCopy from './aux-event-classes/PasteEventCopy'
import DirectFileCopy from './aux-event-classes/DirectFileCopy'
import AuthenticatedImgurClient from './imgur/AuthenticatedImgurClient'
import ImgurSize from './imgur/resizing/ImgurSize'
import editorCheckCallbackFor from './imgur/resizing/plugin-callback'
import ImgurPluginSettingsTab from './ui/ImgurPluginSettingsTab'
import InfoModal from './ui/InfoModal'
import RemoteUploadConfirmationDialog from './ui/RemoteUploadConfirmationDialog'
import UpdateLinksConfirmationModal from './ui/UpdateLinksConfirmationModal'
import ApiError from './uploader/ApiError'
import ImageUploader from './uploader/ImageUploader'
import buildUploaderFrom from './uploader/imgUploaderFactory'
import ImgurAuthenticatedUploader from './uploader/imgur/ImgurAuthenticatedUploader'
import { allFilesAreImages } from './utils/FileList'
import { findLocalFileUnderCursor } from './utils/editor'
import { fixImageTypeIfNeeded } from './utils/misc'
import { ImageURL } from './utils/types'

declare module 'obsidian' {
  interface MarkdownSubView {
    clipboardManager: ClipboardManager
  }

  interface CanvasView extends TextFileView {
    handlePaste: (e: ClipboardEvent) => Promise<void>
  }

  interface Editor {
    getClickableTokenAt(position: EditorPosition): ClickableToken | null
  }

  interface ClickableToken {
    displayText: string
    text: string
    type: string
    start: EditorPosition
    end: EditorPosition
  }
}

interface ClipboardManager {
  handlePaste(e: ClipboardEvent): void
  handleDrop(e: DragEvent): void
}

export interface ImgurPluginSettings {
  uploadStrategy: string
  clientId: string
  showRemoteUploadConfirmation: boolean
  albumToUpload: string | undefined
}

const DEFAULT_SETTINGS: ImgurPluginSettings = {
  uploadStrategy: UploadStrategy.ANONYMOUS_IMGUR.id,
  clientId: null,
  showRemoteUploadConfirmation: true,
  albumToUpload: undefined,
}

interface LocalImageInEditor {
  image: ImageURL
  editor: Editor
  noteFile: TFile
}

export default class ImgurPlugin extends Plugin {
  settings: ImgurPluginSettings

  private imgUploaderField: ImageUploader

  getCurrentImagesUploader(): ImageUploader {
    return this.imgUploaderField
  }

  private customPasteEventCallback = async (
    e: ClipboardEvent,
    _: Editor,
    markdownView: MarkdownView,
  ) => {
    if (e instanceof PasteEventCopy) return
    if (e instanceof DirectFileCopy) return

    if (!this.imgUploader) {
      ImgurPlugin.showUnconfiguredPluginNotice()
      return
    }

    const { files } = e.clipboardData

    if (!allFilesAreImages(files)) return

    e.preventDefault()

    if (this.settings.showRemoteUploadConfirmation) {
      const modal = new RemoteUploadConfirmationDialog(this.app)
      modal.open()

      const userResp = await modal.response()
      switch (userResp.shouldUpload) {
        case undefined:
          return
        case true:
          if (userResp.alwaysUpload) {
            this.settings.showRemoteUploadConfirmation = false
            void this.saveSettings()
          }
          break
        case false:
          markdownView.currentMode.clipboardManager.handlePaste(new PasteEventCopy(e))
          return
        default:
          return
      }
    }

    for (const file of files) {
      this.uploadFileAndEmbedImgurImage(file).catch(() => {
          markdownView.currentMode.clipboardManager.handlePaste(new PasteEventCopy(e))
      })
    }
  }

  private customDropEventListener = async (e: DragEvent, _: Editor, markdownView: MarkdownView) => {
    if (e instanceof DragEventCopy) return

    if (!this.imgUploader) {
      ImgurPlugin.showUnconfiguredPluginNotice()
      return
    }

    if (e.dataTransfer.types.length !== 1 || e.dataTransfer.types[0] !== 'Files') {
      return
    }

    // Preserve files before showing modal, otherwise they will be lost from the event
    const { files } = e.dataTransfer

    if (!allFilesAreImages(files)) return

    e.preventDefault()

    if (this.settings.showRemoteUploadConfirmation) {
      const modal = new RemoteUploadConfirmationDialog(this.app)
      modal.open()

      const userResp = await modal.response()
      switch (userResp.shouldUpload) {
        case undefined:
          return
        case true:
          if (userResp.alwaysUpload) {
            this.settings.showRemoteUploadConfirmation = false
            void this.saveSettings()
          }
          break
        case false: {
          markdownView.currentMode.clipboardManager.handleDrop(DragEventCopy.create(e, files))
          return
        }
        default:
          return
      }
    }

    // Adding newline to avoid messing images pasted via default handler
    // with any text added by the plugin
    this.getEditor().replaceSelection('\n')

    const promises: Promise<any>[] = []
    const filesFailedToUpload: File[] = []
    for (const image of files) {
      const uploadPromise = this.uploadFileAndEmbedImgurImage(image).catch(() => {
          filesFailedToUpload.push(image)
      })
      promises.push(uploadPromise)
    }

    await Promise.all(promises)

    if (filesFailedToUpload.length === 0) {
      return
    }

    markdownView.currentMode.clipboardManager.handleDrop(
      DragEventCopy.create(e, filesFailedToUpload),
    )
  }

  private imgurPluginRightClickHandler = (menu: Menu, editor: Editor, view: MarkdownView) => {
    const localFile = findLocalFileUnderCursor(editor, view)
    if (!localFile.file) {
      menu.addItem((item) => {
        item
          .setTitle('Download cursor file from LFS')
          .setIcon('wand')
          .onClick(() => this.editorCheckCallbackForRemoteDownload(false, editor, view))
      })
    } else { 
      menu.addItem((item) => {
        item
          .setTitle('Upload cursor file to LFS')
          .setIcon('wand')
          .onClick(() => this.doUploadLocalImage({ image: localFile, editor, noteFile: view.file }))
      })
    }
  }

  private async doUploadLocalImage(imageInEditor: LocalImageInEditor) {
    const { image, editor, noteFile } = imageInEditor
    const { file: imageFile, start, end, notePath} = image
    const imageUrl = await this.uploadLocalImageFromEditor(editor, imageFile, start, end, notePath)
    console.warn("upload ok imageUrl:", imageUrl)
    console.warn("upload ok imageFile:", imageFile)
    this.proposeToReplaceOtherLocalLinksIfAny(imageFile, imageUrl, {
      path: noteFile.path,
      startPosition: start,
    })
  }

  private proposeToReplaceOtherLocalLinksIfAny(
    originalLocalFile: TFile,
    remoteImageUrl: string,
    originalReference: { path: string; startPosition: EditorPosition },
  ) {
    const otherReferencesByNote = this.getAllCachedReferencesForFile(originalLocalFile)
    removeReferenceToOriginalNoteIfPresent(otherReferencesByNote, originalReference)

    const notesWithSameLocalFile = Object.keys(otherReferencesByNote)
    if (notesWithSameLocalFile.length === 0) return

    this.showLinksUpdateDialog(originalLocalFile, remoteImageUrl, otherReferencesByNote)
  }

  private getAllCachedReferencesForFile(file: TFile) {
    const allLinks = this.app.metadataCache.resolvedLinks

    const notesWithLinks = []
    for (const [notePath, noteLinks] of Object.entries(allLinks)) {
      for (const [linkName] of Object.entries(noteLinks)) {
        if (linkName === file.name) notesWithLinks.push(notePath)
      }
    }

    const linksByNote = notesWithLinks.reduce(
      (acc, note) => {
        const noteMetadata = this.app.metadataCache.getCache(note)
        const noteLinks = noteMetadata.embeds
        if (noteLinks) {
          acc[note] = noteLinks.filter((l) => l.link === file.name)
        }
        return acc
      },
      {} as Record<string, ReferenceCache[]>,
    )
    return linksByNote
  }

  private showLinksUpdateDialog(
    localFile: TFile,
    remoteImageUrl: string,
    otherReferencesByNote: Record<string, ReferenceCache[]>,
  ) {
    const stats = getFilesAndLinksStats(otherReferencesByNote)
    const dialogBox = new UpdateLinksConfirmationModal(this.app, localFile.path, stats)
    dialogBox.onDoNotUpdateClick(() => dialogBox.close())
    dialogBox.onDoUpdateClick(() => {
      dialogBox.disableButtons()
      dialogBox.setContent('Working...')
      this.replaceAllLocalReferencesWithRemoteOne(otherReferencesByNote, remoteImageUrl)
        .catch((e) => {
          new InfoModal(
            this.app,
            'Error',
            'Unexpected error occurred, check Developer Tools console for details',
          ).open()
          console.error('Something bad happened during links update', e)
        })
        .finally(() => dialogBox.close())
      new Notice(`Updated ${stats.linksCount} links in ${stats.filesCount} files`)
    })
    dialogBox.open()
  }

  private async replaceAllLocalReferencesWithRemoteOne(
    referencesByNotes: Record<string, ReferenceCache[]>,
    remoteImageUrl: string,
  ) {
    for (const [notePath, refs] of Object.entries(referencesByNotes)) {
      const noteFile = this.app.vault.getFileByPath(notePath)
      const refsStartOffsetsSortedDescending = refs
        .map((ref) => ({
          start: ref.position.start.offset,
          end: ref.position.end.offset,
        }))
        .sort((ref1, ref2) => ref2.start - ref1.start)

      await this.app.vault.process(noteFile, (noteContent) => {
        let updatedContent = noteContent
        refsStartOffsetsSortedDescending.forEach((refPos) => {
          updatedContent =
            updatedContent.substring(0, refPos.start) +
            `![](${remoteImageUrl})` +
            updatedContent.substring(refPos.end)
        })
        return updatedContent
      })
    }
  }

  private async uploadLocalImageFromEditor(
    editor: Editor,
    file: TFile,
    start: EditorPosition,
    end: EditorPosition,
    notePath: string,
  ) {
    console.warn('uploadLocalImageFromEditor 1')
    const arrayBuffer = await this.app.vault.readBinary(file)
    const fileToUpload = new File([arrayBuffer], file.name)
    editor.replaceRange('\n', end, end)
    const imageUrl = await this.uploadFileAndEmbedImgurImage(fileToUpload, {
      ch: 0,
      line: end.line + 1,
    }, notePath)
    editor.replaceRange(`<!--${editor.getRange(start, end).replace(/!?\[\[(.*?)\]\]/g, "$1")}-->`, start, end)
    return imageUrl
  }

  get imgUploader(): ImageUploader {
    return this.imgUploaderField
  }

  private async loadSettings() {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...((await this.loadData()) as ImgurPluginSettings),
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  onload() {
    void this.initPlugin()
  }

  private async initPlugin() {
    await this.loadSettings()
    this.addSettingTab(new ImgurPluginSettingsTab(this.app, this))

    this.setupImagesUploader()
    this.setupImgurHandlers()
    this.addResizingCommands()
    this.addUploadLocalCommand()
    this.addDownloadLocalCommand()
  }

  setupImagesUploader(): void {
    const uploader = buildUploaderFrom(this.settings)
    this.imgUploaderField = uploader
    if (!uploader) return

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalUploadFunction = uploader.upload
    uploader.upload = function (image: File, albumId?: string) {
      if (!uploader) return
      return originalUploadFunction.call(uploader, fixImageTypeIfNeeded(image), albumId)
    }
  }

  private setupImgurHandlers() {
    this.registerEvent(this.app.workspace.on('editor-paste', this.customPasteEventCallback))
    this.registerEvent(this.app.workspace.on('editor-drop', this.customDropEventListener))
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        const view = leaf.view

        if (view.getViewType() === 'canvas') {
          this.overridePasteHandlerForCanvasView(view as CanvasView)
        }
      }),
    )

    this.registerEvent(this.app.workspace.on('editor-menu', this.imgurPluginRightClickHandler))
  }

  private overridePasteHandlerForCanvasView(view: CanvasView) {
    const originalPasteFn = view.handlePaste
    view.handlePaste = createImgurCanvasPasteHandler(this, originalPasteFn)
  }

  private addResizingCommands() {
    const sizes = ImgurSize.values()
    for (const size of sizes) {
      this.addCommand({
        id: `imgur-resize-${size.suffix}-command`,
        name: `Resize to ${size.description}${size.sizeHint ? ` (${size.sizeHint})` : ''}`,
        editorCheckCallback: editorCheckCallbackFor(size),
      })
    }
  }

  private addUploadLocalCommand() {
    this.addCommand({
      id: 'imgur-upload-local',
      name: 'Upload local to LFS',
      editorCheckCallback: this.editorCheckCallbackForLocalUpload,
    })
  }

  private addDownloadLocalCommand() {
    this.addCommand({
      id: 'imgur-download-local',
      name: 'Download LFS to local',
      editorCheckCallback: this.editorCheckCallbackForRemoteDownload,
    })
  }

  private editorCheckCallbackForLocalUpload = (
    checking: boolean,
    editor: Editor,
    ctx: MarkdownFileInfo,
  ) => {
    const localFile = findLocalFileUnderCursor(editor, ctx)
    if (!localFile) return false
    if (checking) return true

    void this.doUploadLocalImage({ image: localFile, editor, noteFile: ctx.file })
  }

  private editorCheckCallbackForRemoteDownload = (
    checking: boolean,
    editor: Editor,
    ctx: MarkdownFileInfo,
  ) => {
    const imageURL = findLocalFileUnderCursor(editor, ctx)
    if (imageURL.file) return false
    if (checking) return true
    const imageRes = this.downloadFileAndEmbedImgurImage(imageURL, {
      ch: 0,
      line: imageURL.end.line + 1,
    })
  }

  getAuthenticatedImgurClient(): AuthenticatedImgurClient | null {
    if (this.imgUploader instanceof ImgurAuthenticatedUploader) {
      return this.imgUploader.client
    }

    return null
  }

  private static showUnconfiguredPluginNotice() {
    const fiveSecondsMillis = 5_000
    new Notice('⚠️ Please configure Client ID for Imgur plugin or disable it', fiveSecondsMillis)
  }

  private async uploadFileAndEmbedImgurImage(file: File, atPos?: EditorPosition, notePath?: string) {
    const pasteId = (Math.random() + 1).toString(36).substring(2, 7)
    this.insertTemporaryText(pasteId, atPos)

    let imgUrl: string
    try {
      console.warn('imgUploaderField.upload', file)
      imgUrl = await this.imgUploaderField.upload(file, notePath, this.settings.albumToUpload)
    } catch (e) {
      if (e instanceof ApiError) {
        this.handleFailedUpload(
          pasteId,
          `Upload failed, remote server returned an error: ${e.message}`,
        )
      } else {
        console.error('Failed imgur request: ', e)
        this.handleFailedUpload(pasteId, `⚠️Imgur upload failed, error: ${e.message}`)
      }
      throw e
    }
    this.embedMarkDownImage(pasteId, imgUrl, file)
    return imgUrl
  }

  private async downloadFileAndEmbedImgurImage(imageURL: ImageURL, atPos?: EditorPosition) {
    const pasteId = (Math.random() + 1).toString(36).substring(2, 7)
    this.insertTemporaryText(pasteId, atPos)
    let imgFile: string
    try {
      const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
      imgFile = await this.imgUploaderField.download(mdView, imageURL)
    } catch (e) {
      if (e instanceof ApiError) {
        this.handleFailedUpload(
          pasteId,
          `Upload failed, remote server returned an error: ${e.message}`,
        )
      } else {
        console.error('Failed imgur request: ', e)
        this.handleFailedUpload(pasteId, `⚠️Imgur upload failed, error: ${e.message}`)
      }
      throw e
    }

    const progressText = ImgurPlugin.progressTextFor(pasteId)
    ImgurPlugin.replaceFirstOccurrence(this.getEditor(), progressText, '')
    return imgFile
  }

  private insertTemporaryText(pasteId: string, atPos?: EditorPosition) {
    const progressText = ImgurPlugin.progressTextFor(pasteId)
    const replacement = `${progressText}\n`
    const editor = this.getEditor()
    if (atPos) {
      editor.replaceRange(replacement, atPos, atPos)
    } else {
      this.getEditor().replaceSelection(replacement)
    }
  }

  private static progressTextFor(id: string) {
    return `![Processing ...${id}]()`
  }

  private embedMarkDownImage(pasteId: string, imageUrl: string, file: File) {
    const progressText = ImgurPlugin.progressTextFor(pasteId)
    if (!imageUrl.startsWith('http')) {
        console.warn("embedMarkDownImage--url", imageUrl)
        const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
        const lt = parseLinktext(imageUrl)
        const attach_file = mdView.app.metadataCache.getFirstLinkpathDest(lt.path, mdView.file.path)
        console.warn("embedMarkDownImage--lt", lt)
        console.warn("embedMarkDownImage--attach_file", attach_file)
        if (attach_file) {
            if (imageUrl.startsWith(attach_file.name)) {
                const markDownImage = `![[${imageUrl}]]`
                ImgurPlugin.replaceFirstOccurrence(this.getEditor(), progressText, markDownImage)
            } else {
                const UrlParts = imageUrl.split('#');
                UrlParts.shift()
                const markDownImage = `![[${attach_file.name}#${UrlParts.join('#')}]]`
                ImgurPlugin.replaceFirstOccurrence(this.getEditor(), progressText, markDownImage)
            }
        } else {
            const markDownImage = ``
            ImgurPlugin.replaceFirstOccurrence(this.getEditor(), progressText, markDownImage)
            const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (mdView) {
                mdView.currentMode.clipboardManager.handlePaste(new DirectFileCopy(file));
            }
        }
    } else {
        const markDownImage = `![](${imageUrl})`
        ImgurPlugin.replaceFirstOccurrence(this.getEditor(), progressText, markDownImage)
    }
  }

  private handleFailedUpload(pasteId: string, message: string) {
    const progressText = ImgurPlugin.progressTextFor(pasteId)
    ImgurPlugin.replaceFirstOccurrence(this.getEditor(), progressText, `<!--${message}-->`)
  }

  private getEditor(): Editor {
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView)
    return mdView.editor
  }

  private static replaceFirstOccurrence(editor: Editor, target: string, replacement: string) {
    const lines = editor.getValue().split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const ch = lines[i].indexOf(target)
      if (ch !== -1) {
        const from = { line: i, ch }
        const to = { line: i, ch: ch + target.length }
        editor.replaceRange(replacement, from, to)
        break
      }
    }
  }
}

function removeReferenceToOriginalNoteIfPresent(
  otherReferencesByNote: Record<string, ReferenceCache[]>,
  originalNote: { path: string; startPosition: EditorPosition },
) {
  if (!Object.keys(otherReferencesByNote).includes(originalNote.path)) return

  const refsFromOriginalNote = otherReferencesByNote[originalNote.path]
  const originalRefStart = originalNote.startPosition
  const refForExclusion = refsFromOriginalNote.find(
    (r) =>
      r.position.start.line === originalRefStart.line &&
      r.position.start.col === originalRefStart.ch,
  )
  if (refForExclusion) {
    refsFromOriginalNote.remove(refForExclusion)
    if (refsFromOriginalNote.length === 0) {
      delete otherReferencesByNote[originalNote.path]
    }
  }
}

function getFilesAndLinksStats(otherReferencesByNote: Record<string, ReferenceCache[]>) {
  return {
    filesCount: Object.keys(otherReferencesByNote).length,
    linksCount: Object.values(otherReferencesByNote).reduce(
      (count, refs) => count + refs.length,
      0,
    ),
  }
}
