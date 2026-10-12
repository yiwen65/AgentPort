import { invoke, isTauri } from "@tauri-apps/api/core";
import type { FileDownloadClient, FileDownloadSnapshot, FileDownloadSource } from "../protocol/fileDownloadClient";

export class TauriFileDownloadClient implements FileDownloadClient {
  available() { return isTauri(); }
  start(request: FileDownloadSource) { return invoke<FileDownloadSnapshot>("mobile_file_download_start", { request }); }
  poll(jobId: string) { return invoke<FileDownloadSnapshot>("mobile_file_download_poll", { jobId }); }
  cancel(jobId: string) { return invoke<FileDownloadSnapshot>("mobile_file_download_cancel", { jobId }); }
  save(jobId: string) { return invoke<FileDownloadSnapshot>("mobile_file_download_save", { jobId }); }
  discard(jobId: string) { return invoke<void>("mobile_file_download_discard", { jobId }); }
}
export const fileDownloadClient = new TauriFileDownloadClient();
