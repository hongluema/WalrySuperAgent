const command = process.argv[2];

if (command === 'init') {
  import('./config/init.js').then(m => m.runInit());
} else if (command === 'web') {
  import('./web/server.js').then(m => m.startWeb().catch(console.error));
} else {
  import('./main.js').then(m => m.startAgent().catch(console.error));
}