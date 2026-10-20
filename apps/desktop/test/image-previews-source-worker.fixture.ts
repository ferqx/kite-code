// Generates real high-resolution inputs outside the measured UI work.
self.onmessage = async () => {
  const files: Blob[] = [];
  for (let index = 0; index < 10; index++) {
    const canvas = new OffscreenCanvas(4000, 3000);
    const context = canvas.getContext('2d')!;
    const gradient = context.createLinearGradient(0, 0, 4000, 3000);
    gradient.addColorStop(0, `hsl(${index * 31} 70% 55%)`);
    gradient.addColorStop(1, `hsl(${index * 31 + 140} 70% 20%)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 4000, 3000);
    context.fillStyle = 'white';
    context.font = '140px sans-serif';
    context.fillText(`Original ${index + 1}: 4000 x 3000`, 100, 300);
    files.push(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 }));
    canvas.width = canvas.height = 0;
  }
  self.postMessage(files);
};
