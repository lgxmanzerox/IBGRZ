
import React, { useState, useRef, useCallback, useEffect } from 'react';
import type { RGBColor } from './types';
import Icon from './components/Icon';

const QUANTIZATION_FACTOR = 4; // 2^4 = 16 levels per channel

// Helper to convert RGB to Hex
const rgbToHex = (r: number, g: number, b: number): string => {
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
};

// Helper to convert Hex to RGB
const hexToRgb = (hex: string): RGBColor | null => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
};

// --- Child Components ---

interface FileUploadAreaProps {
  onFileSelect: (file: File) => void;
  isProcessing: boolean;
}

const FileUploadArea: React.FC<FileUploadAreaProps> = ({ onFileSelect, isProcessing }) => (
  <div className="w-full max-w-2xl mx-auto">
    <label htmlFor="dropzone-file" className="flex flex-col items-center justify-center w-full h-64 border-2 border-dashed rounded-lg cursor-pointer bg-gray-50 dark:bg-gray-800 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
      <div className="flex flex-col items-center justify-center pt-5 pb-6">
        <Icon name="upload" className="w-10 h-10 mb-3 text-gray-400" />
        <p className="mb-2 text-sm text-gray-500 dark:text-gray-400"><span className="font-semibold">Click to upload</span> or drag and drop</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">PNG or JPG</p>
      </div>
      <input
        id="dropzone-file"
        type="file"
        className="hidden"
        accept="image/png, image/jpeg"
        onChange={(e) => e.target.files && onFileSelect(e.target.files[0])}
        disabled={isProcessing}
      />
    </label>
  </div>
);


const App: React.FC = () => {
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [palette, setPalette] = useState<string[]>([]);
  const [selectedColors, setSelectedColors] = useState<string[]>([]);
  const [tolerance, setTolerance] = useState<number>(20);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [resultImage, setResultImage] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(new Image());

  const resetState = () => {
    setImageFile(null);
    setPalette([]);
    setSelectedColors([]);
    setTolerance(20);
    setIsProcessing(false);
    setResultImage(null);
    if(canvasRef.current){
        const context = canvasRef.current.getContext('2d');
        context?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    }
  };

  const extractColors = useCallback((imageData: ImageData): string[] => {
    const colorCount = new Map<string, number>();
    const { data } = imageData;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] >> QUANTIZATION_FACTOR;
      const g = data[i + 1] >> QUANTIZATION_FACTOR;
      const b = data[i + 2] >> QUANTIZATION_FACTOR;
      const a = data[i + 3];

      if (a > 128) { // Only count opaque pixels
        const key = `${r},${g},${b}`;
        colorCount.set(key, (colorCount.get(key) || 0) + 1);
      }
    }

    const sortedColors = Array.from(colorCount.entries()).sort((a, b) => b[1] - a[1]);
    
    return sortedColors.slice(0, 15).map(color => {
      const [r, g, b] = color[0].split(',').map(c => parseInt(c) << QUANTIZATION_FACTOR);
      return rgbToHex(r, g, b);
    });
  }, []);

  // Effect for loading the initial image
  useEffect(() => {
    if (imageFile) {
      setIsProcessing(true);
      const reader = new FileReader();
      reader.onload = (e) => {
        imageRef.current.src = e.target?.result as string;
        imageRef.current.onload = () => {
          const image = imageRef.current;
          // Use a small temporary canvas for quick color extraction
          const tempCanvas = document.createElement('canvas');
          const aspectRatio = image.width / image.height;
          tempCanvas.width = 200; 
          tempCanvas.height = 200 / aspectRatio;
          
          const tempCtx = tempCanvas.getContext('2d');
          if(!tempCtx) {
              setIsProcessing(false);
              return;
          }

          tempCtx.drawImage(image, 0, 0, tempCanvas.width, tempCanvas.height);
          const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
          const colors = extractColors(imageData);
          setPalette(colors);
          
          // Set up the main canvas
          const mainCanvas = canvasRef.current;
          if(mainCanvas){
            const mainCtx = mainCanvas.getContext('2d');
            mainCanvas.width = image.width;
            mainCanvas.height = image.height;
            mainCtx?.drawImage(image, 0, 0);
            setResultImage(mainCanvas.toDataURL('image/png'));
          }

          setIsProcessing(false);
        };
        imageRef.current.onerror = () => {
            setIsProcessing(false);
            // Handle image load error
        }
      };
      reader.readAsDataURL(imageFile);
    }
  }, [imageFile, extractColors]);

  // Effect for processing color removal whenever selection or tolerance changes
  useEffect(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;

    if (!imageFile || !canvas || !image.src) return;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    
    // Always start by redrawing the original image to handle deselecting colors
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    if (selectedColors.length === 0) {
        // If no colors are selected, the original image is our result
        setResultImage(canvas.toDataURL('image/png'));
        return;
    }

    setIsProcessing(true);
    
    // Use a timeout to allow the UI to update before this heavy operation
    const timer = setTimeout(() => {
        const targetRgbs = selectedColors.map(hexToRgb).filter(Boolean) as RGBColor[];
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        const toleranceSquared = (tolerance / 100) * (255 * 255 * 3);

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            
            for (const targetRgb of targetRgbs) {
                const distanceSquared = Math.pow(r - targetRgb.r, 2) + Math.pow(g - targetRgb.g, 2) + Math.pow(b - targetRgb.b, 2);
                if (distanceSquared < toleranceSquared) {
                    data[i + 3] = 0; // Make transparent
                    break; // Matched a color, no need to check other selected colors for this pixel
                }
            }
        }

        ctx.putImageData(imageData, 0, 0);
        setResultImage(canvas.toDataURL('image/png'));
        setIsProcessing(false);
    }, 10);

    return () => clearTimeout(timer);

  }, [selectedColors, tolerance, imageFile]);

  const handleFileSelect = (file: File) => {
      resetState();
      setImageFile(file);
  };
  
  const handleColorSelect = (color: string) => {
    setSelectedColors(prev => 
        prev.includes(color) 
        ? prev.filter(c => c !== color) 
        : [...prev, color]
    );
  };

  return (
    <div className="min-h-screen text-gray-800 dark:text-gray-200 p-4 sm:p-6 lg:p-8">
      <header className="text-center mb-8">
        <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-white">Image Background Remover</h1>
        <p className="mt-2 text-lg text-gray-600 dark:text-gray-400">Remove image backgrounds by selecting one or more colors.</p>
      </header>

      <main>
        {!imageFile ? (
            <FileUploadArea onFileSelect={handleFileSelect} isProcessing={isProcessing} />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Controls Column */}
            <div className="lg:col-span-1 bg-white dark:bg-gray-800 p-6 rounded-lg shadow-md h-fit">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-semibold">Controls</h2>
                <button
                    onClick={resetState}
                    className="p-2 rounded-full text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                    aria-label="Remove image and start over"
                >
                    <Icon name="trash" className="w-5 h-5" />
                </button>
              </div>

              {/* Color Palette */}
              <div>
                <h3 className="text-md font-medium mb-3 flex items-center gap-2"><Icon name="palette" className="w-5 h-5"/> Extracted Colors</h3>
                <div className="flex flex-wrap gap-2">
                  {palette.length > 0 ? palette.map(color => (
                    <button
                      key={color}
                      onClick={() => handleColorSelect(color)}
                      className={`w-8 h-8 rounded-full border-2 transition-transform transform hover:scale-110 ${selectedColors.includes(color) ? 'border-blue-500 scale-110' : 'border-gray-300 dark:border-gray-600'}`}
                      style={{ backgroundColor: color }}
                      aria-label={`Select color ${color}`}
                    />
                  )) : (
                     <p className="text-sm text-gray-500">Extracting colors...</p>
                  )}
                </div>
              </div>

              {/* Tolerance Slider */}
              {selectedColors.length > 0 && (
                <div className="mt-8">
                  <label htmlFor="tolerance" className="block text-md font-medium mb-2">Color Tolerance</label>
                  <input
                    id="tolerance"
                    type="range"
                    min="0"
                    max="100"
                    value={tolerance}
                    onChange={(e) => setTolerance(parseInt(e.target.value))}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700"
                  />
                  <div className="text-center text-sm mt-1 text-gray-500 dark:text-gray-400">{tolerance}</div>
                </div>
              )}

              {/* Download Button */}
              <div className="mt-8">
                 <a
                    href={resultImage || '#'}
                    download="processed-image.png"
                    className={`w-full flex items-center justify-center gap-2 px-4 py-3 font-semibold text-white rounded-lg shadow-md transition-colors ${
                        resultImage && !isProcessing
                        ? 'bg-blue-600 hover:bg-blue-700'
                        : 'bg-gray-400 cursor-not-allowed'
                    }`}
                    onClick={(e) => (!resultImage || isProcessing) && e.preventDefault()}
                >
                    <Icon name="download" className="w-5 h-5" />
                    Download PNG
                </a>
              </div>
            </div>

            {/* Image Preview Column */}
            <div className="lg:col-span-2 bg-white dark:bg-gray-800 p-6 rounded-lg shadow-md flex items-center justify-center min-h-[300px] relative overflow-hidden">
                {isProcessing && (
                    <div className="absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center z-10">
                        <div className="w-16 h-16 border-4 border-t-blue-500 border-gray-200 rounded-full animate-spin"></div>
                    </div>
                )}
                <div 
                    className="max-w-full max-h-full bg-cover"
                    style={{ backgroundImage: "url(\"data:image/svg+xml,%3csvg width='100%25' height='100%25' xmlns='http://www.w3.org/2000/svg'%3e%3crect width='100%25' height='100%25' fill='none'%3e%3c/rect%3e%3cpattern id='p' width='20' height='20' patternUnits='userSpaceOnUse'%3e%3crect x='0' y='0' width='10' height='10' fill='%23e5e5e5'/%3e%3crect x='10' y='10' width='10' height='10' fill='%23e5e5e5'/%3e%3c/pattern%3e%3crect width='100%25' height='100%25' fill='url(%23p)'/%3e%3c/svg%3e\")" }}
                >
                    <canvas ref={canvasRef} className="max-w-full max-h-[70vh] object-contain" />
                </div>
            </div>
          </div>
        )}
      </main>

      <footer className="text-center mt-12 text-sm text-gray-500 dark:text-gray-400">
        <p>Built with React, TypeScript, and Tailwind CSS. All processing is done in your browser.</p>
      </footer>
    </div>
  );
};

export default App;
