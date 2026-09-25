import { initMap, bindMapControls } from './map.js';
import { buildAssumeUI } from './ui/assumptions.js';
import { initChrome } from './ui/chrome.js';
import { initPanel } from './ui/panel.js';
import { initSearch } from './ui/search.js';

initMap();
bindMapControls();
buildAssumeUI();
initChrome();
initPanel();
initSearch();
