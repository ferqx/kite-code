import { mountWebPage } from './mount';

const element = document.getElementById('root');
if (element) void mountWebPage({ window, element });
