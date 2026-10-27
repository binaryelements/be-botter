// Runs before first paint, as a file because the app's CSP blocks inline scripts.
// Web and desktop are dark only, like BE Hub and BE Voice.
document.documentElement.dataset.theme = "dark";
document.documentElement.style.colorScheme = "dark";
