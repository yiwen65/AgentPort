declare module "*.svg" {
  const src: string;
  export default src;
}

declare module "*.svg?raw" {
  const svg: string;
  export default svg;
}

declare module "*.ico" {
  const src: string;
  export default src;
}
