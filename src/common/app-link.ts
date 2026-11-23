// <appUrl>/<path>, keeping a path the front is served under: the base gets a trailing
// slash and the path is relative, or URL would replace the base's last segment.
export const appLink = (appUrl: string, path: string) => new URL(path, appUrl.replace(/\/?$/, '/')).href;
