export type FileDownloadState = "downloading" | "ready" | "saving" | "saved" | "failed" | "cancelled";
export interface FileDownloadSource { profileId: string; sessionId: string; path: string }
export interface FileDownloadSnapshot extends FileDownloadSource {
  jobId: string;
  name: string;
  totalBytes: number;
  receivedBytes: number;
  state: FileDownloadState;
  error?: { code: string; message: string };
}
/** Native owns file bytes, authenticated transport and temporary paths. */
export interface FileDownloadClient {
  available(): boolean;
  start(source: FileDownloadSource): Promise<FileDownloadSnapshot>;
  poll(jobId: string): Promise<FileDownloadSnapshot>;
  cancel(jobId: string): Promise<FileDownloadSnapshot>;
  save(jobId: string): Promise<FileDownloadSnapshot>;
  discard(jobId: string): Promise<void>;
}
