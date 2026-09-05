// The browser-only API used here. @types/qrcode imports global Node types,
// which conflict with this frontend's intentionally browser-scoped test shims.
declare module "qrcode" {
  const QRCode: { toDataURL(text: string, options: { errorCorrectionLevel: "M"; width: number; margin: number }): Promise<string> };
  export default QRCode;
}
