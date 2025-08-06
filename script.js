// ---------------------
// State & structures for series grouping
// ---------------------
const element = document.getElementById('dicomElement');
let studies = {}; // studyUID => { studyUID, studyDate, patientName, series: { seriesUID => { seriesUID, seriesDesc, images: [ {file, imageId, instance} ], loadedImages: [cornerstoneImageObjects] } } }
let currentStudyUID = null;
let currentSeriesUID = null;
let currentSeriesImages = []; // currently displayed series images (cornerstone image objects)
let currentSliceIndex = 0;

// ---------------------
// Helpers: ensure config
// ---------------------
function ensureGlobalConfig() {
  if (typeof cornerstoneTools !== 'undefined') {
    cornerstoneTools.globalConfiguration = cornerstoneTools.globalConfiguration || {};
    cornerstoneTools.globalConfiguration.configuration = cornerstoneTools.globalConfiguration.configuration || {};
    if (typeof cornerstoneTools.globalConfiguration.configuration.globalToolSyncEnabled === 'undefined') {
      cornerstoneTools.globalConfiguration.configuration.globalToolSyncEnabled = false;
    }
  }
}

// ---------------------
// New helpers: DICOM extension check and DataTransfer traversal
// ---------------------
function isAllowedDicomFile(fileName) {
  return /\.(dcm|dicom)$/i.test(fileName || '');
}

// Recursively read DataTransfer items (files + directories) and return Promise<File[]>
// Uses webkitGetAsEntry where available, with fallback to dataTransfer.files
function getFilesFromDataTransfer(dataTransfer) {
  return new Promise((resolve) => {
    const items = dataTransfer.items;
    const files = [];

    if (!items) {
      // fallback: use files list directly
      const fileList = Array.from(dataTransfer.files || []);
      resolve(fileList);
      return;
    }

    let pending = 0;
    let finishedCalled = 0;

    function maybeResolve() {
      // resolve when no pending left
      if (pending === 0) resolve(files);
    }

    function readEntry(entry, path = '') {
      if (!entry) return;
      if (entry.isFile) {
        pending++;
        entry.file(file => {
          // preserve relative path if available
          try { file.relativePath = path + file.name; } catch (e) {}
          files.push(file);
          pending--;
          maybeResolve();
        }, (err) => {
          console.warn('entry.file error', err);
          pending--;
          maybeResolve();
        });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        // readEntries may return multiple times until empty
        pending++;
        reader.readEntries((entries) => {
          // finished reading this directory's chunk
          pending--;
          // push children
          for (let i = 0; i < entries.length; i++) {
            readEntry(entries[i], path + entry.name + '/');
          }
          maybeResolve();
        }, (err) => {
          console.warn('readEntries error', err);
          pending--;
          maybeResolve();
        });
      } else {
        // unknown entry type
      }
    }

    // iterate items
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      // If webkitGetAsEntry available
      try {
        const entry = (typeof it.webkitGetAsEntry === 'function') ? it.webkitGetAsEntry() : null;
        if (entry) {
          readEntry(entry);
        } else {
          // fallback to getAsFile
          const f = (typeof it.getAsFile === 'function') ? it.getAsFile() : null;
          if (f) {
            try { f.relativePath = f.webkitRelativePath || f.relativePath || f.name; } catch (e) {}
            files.push(f);
          }
        }
      } catch (e) {
        console.warn('Error reading dataTransfer item', e);
      }
    }

    // If nothing queued, resolve immediately
    if (pending === 0) {
      resolve(files);
    }
    // otherwise resolution will happen when pending goes to zero
  });
}

// ---------------------
// Initialize Cornerstone & Tools
// ---------------------
function initializeCornerstone() {
  try {
    ensureGlobalConfig();

    // Wire externals
    cornerstoneWADOImageLoader.external.cornerstone = cornerstone;
    cornerstoneWADOImageLoader.external.dicomParser = dicomParser;
    cornerstoneTools.external.cornerstone = cornerstone;
    cornerstoneTools.external.cornerstoneMath = cornerstoneMath;

    // Enable element
    cornerstone.enable(element);
    element.tabIndex = 0;
    element.style.outline = 'none';
    element.addEventListener('mouseenter', () => element.focus());

    // Init tools
    cornerstoneTools.init({
      mouseEnabled: true,
      touchEnabled: true,
      globalToolSyncEnabled: false,
      showSVGCursors: true
    });

    // Add core tools
    const { WwwcTool, ZoomTool, PanTool, StackScrollMouseWheelTool, ZoomMouseWheelTool } = cornerstoneTools;
    try { if (WwwcTool) cornerstoneTools.addTool(WwwcTool); } catch(e){console.warn(e)}
    try { if (ZoomTool) cornerstoneTools.addTool(ZoomTool); } catch(e){console.warn(e)}
    try { if (PanTool) cornerstoneTools.addTool(PanTool); } catch(e){console.warn(e)}
    try { if (StackScrollMouseWheelTool) cornerstoneTools.addTool(StackScrollMouseWheelTool); } catch(e){console.warn(e)}
    try { if (ZoomMouseWheelTool) cornerstoneTools.addTool(ZoomMouseWheelTool, { configuration:{invert:false, preventZoomOutsideImage:false} }); } catch(e){}

    safeSetActiveTool('Wwwc');
    try { cornerstoneTools.setToolActive('ZoomMouseWheel', {}); } catch(e){}
    setupEventListeners();
  } catch (err) {
    console.error('initializeCornerstone error', err);
    alert('Initialization error: ' + (err.message || err));
  }
}

// ---------------------
// Tool helpers
// ---------------------
function safeSetActiveTool(toolName, options = { mouseButtonMask: 1 }) {
  ['Wwwc','Zoom','Pan'].forEach(t => { try { if (t !== toolName) cornerstoneTools.setToolPassive(t); } catch(e){} });
  try { cornerstoneTools.setToolActive(toolName, options); } catch(e) { try { cornerstoneTools.setToolActive(toolName + 'Tool', options); } catch(e2){} }
  updateToolButtons(toolName);
  element.focus();
}

function safeSetWheelToolForSeries() {
  try {
    if (currentSeriesImages.length > 1) cornerstoneTools.setToolActive('StackScrollMouseWheel', {});
    else cornerstoneTools.setToolActive('ZoomMouseWheel', {});
  } catch(e) {}
}

function updateToolButtons(activeTool) {
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
  const id = activeTool ? activeTool.toLowerCase() + 'Tool' : null;
  if (id) {
    const elBtn = document.getElementById(id);
    if (elBtn) elBtn.classList.add('active');
  }
}

// ---------------------
// Event listeners & file input wiring
// ---------------------
function setupEventListeners() {
  const fileInput = document.getElementById('fileInput');
  const folderInput = document.getElementById('folderInput');
  const uploadArea = document.getElementById('uploadArea');
  const sliceSlider = document.getElementById('sliceSlider');

  // Normal files selection (filter to .dcm/.dicom)
  fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []).filter(f => isAllowedDicomFile(f.name));
    const invalidCount = (Array.from(e.target.files || []).length - files.length);
    if (invalidCount > 0) {
      // non-blocking alert; replace with toast if you have one
      alert(`${invalidCount} non-DICOM file(s) were ignored. Only .dcm / .dicom files will be loaded.`);
    }
    if (files.length) ingestFiles(files);
    e.target.value = '';
  });

  // Folder selection (webkitdirectory) - files will often have webkitRelativePath
  folderInput.addEventListener('change', (e) => {
    const raw = Array.from(e.target.files || []);
    // use webkitRelativePath if present for naming, but filter by filename
    const files = raw.filter(f => isAllowedDicomFile(f.name || f.webkitRelativePath || ''));
    const invalidCount = raw.length - files.length;
    if (invalidCount > 0) {
      alert(`${invalidCount} non-DICOM file(s) in folder were ignored.`);
    }
    if (files.length) ingestFiles(files);
    e.target.value = '';
  });

  // Drag & drop using DataTransfer traversal; filters for .dcm/.dicom
  uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); });
  uploadArea.addEventListener('dragleave', (e) => { uploadArea.classList.remove('dragover'); });
  uploadArea.addEventListener('drop', async (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');

    try {
      const allFiles = await getFilesFromDataTransfer(e.dataTransfer);
      if (!allFiles || allFiles.length === 0) {
        console.warn('No files found in drop');
        alert('No files found in drop.');
        return;
      }

      // normalize name check to include relativePath if present
      const dicomFiles = allFiles.filter(f => {
        const name = f.name || (f.relativePath || '');
        return isAllowedDicomFile(name);
      });

      const invalidCount = allFiles.length - dicomFiles.length;
      if (invalidCount > 0) {
        alert(`${invalidCount} non-DICOM file(s) were ignored. Only .dcm / .dicom files will be loaded.`);
      }

      if (dicomFiles.length) {
        ingestFiles(dicomFiles);
      } else {
        alert('No DICOM (.dcm / .dicom) files were found in the dropped items.');
      }
    } catch (err) {
      console.error('Error handling drop', err);
      alert('Error during file drop: ' + (err && err.message ? err.message : err));
    }
  });

  sliceSlider.addEventListener('input', (e) => displaySlice(parseInt(e.target.value,10)));

  element.addEventListener('cornerstoneimagerendered', onImageRendered);
  element.addEventListener('cornerstonenewimage', onNewImage);

  document.addEventListener('keydown', (e) => {
    if (!currentSeriesImages.length) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); nextSlice(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); previousSlice(); }
  });
}

// ---------------------
// Ingest files: parse DICOM metadata, group by Study/Series
// (unchanged from your original logic)
// ---------------------
async function ingestFiles(fileList) {
  showLoading(true);
  // make sure the upload overlay is hidden after starting
  document.getElementById('uploadOverlay').classList.add('hidden');

  // For each file, create imageId first (file manager) so we can refer to it
  const fileInfos = fileList.map(file => {
    try {
      const imageId = cornerstoneWADOImageLoader.wadouri.fileManager.add(file);
      return { file, imageId };
    } catch (e) {
      console.warn('fileManager.add failed', e);
      return { file, imageId: null };
    }
  });

  // Read and parse DICOM header for each file
  const readPromises = fileInfos.map(fi => new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = function(ev) {
      try {
        const arrBuf = ev.target.result;
        const byteArray = new Uint8Array(arrBuf);
        const dataSet = dicomParser.parseDicom(byteArray);
        const studyUID = dataSet.string('x0020000d') || 'no-study-uid';
        const seriesUID = dataSet.string('x0020000e') || 'no-series-uid';
        const instanceNumberRaw = dataSet.string('x00200013') || dataSet.string('x00201041') || '0';
        const instanceNumber = parseFloat(instanceNumberRaw) || 0;
        const seriesDesc = dataSet.string('x0008103e') || 'Series';
        const patientName = dataSet.string('x00100010') || 'Unknown';
        const studyDate = dataSet.string('x00080020') || dataSet.string('x00080023') || 'Unknown';

        resolve(Object.assign({}, fi, { studyUID, seriesUID, instanceNumber, seriesDesc, patientName, studyDate }));
      } catch (err) {
        console.warn('parseDicom failed for', fi.file.name, err);
        resolve(Object.assign({}, fi, { studyUID: 'no-study-uid', seriesUID: 'no-series-uid', instanceNumber: 0, seriesDesc: 'Series', patientName:'Unknown', studyDate:'Unknown' }));
      }
    };
    reader.onerror = function() {
      resolve(Object.assign({}, fi, { studyUID: 'no-study-uid', seriesUID: 'no-series-uid', instanceNumber: 0, seriesDesc: 'Series', patientName:'Unknown', studyDate:'Unknown' }));
    };
    reader.readAsArrayBuffer(fi.file);
  }));

  const infos = await Promise.all(readPromises);

  // Group into studies -> series
  infos.forEach(info => {
    const sUID = info.studyUID;
    const seUID = info.seriesUID;
    if (!studies[sUID]) {
      studies[sUID] = { studyUID: sUID, studyDate: info.studyDate, patientName: info.patientName, series: {} };
    }
    if (!studies[sUID].series[seUID]) {
      studies[sUID].series[seUID] = { seriesUID: seUID, seriesDesc: info.seriesDesc || 'Series', images: [] };
    }
    // push file + imageId + instance for sorting later
    studies[sUID].series[seUID].images.push({ file: info.file, imageId: info.imageId, instance: info.instanceNumber, fileName: info.file.name });
  });

  // After grouping, update UI lists
  renderStudiesAndSeries();

  // If first study/series available, auto-select and load first series
  const studyUIDs = Object.keys(studies);
  if (studyUIDs.length) {
    currentStudyUID = studyUIDs[0];
    const seriesUIDs = Object.keys(studies[currentStudyUID].series);
    if (seriesUIDs.length) {
      selectSeries(currentStudyUID, seriesUIDs[0]);
    }
  }

  showLoading(false);
}

// ---------------------
// UI rendering: Studies and Series list
// ---------------------
function renderStudiesAndSeries() {
  const studiesListEl = document.getElementById('studiesList');
  const seriesListEl = document.getElementById('seriesList');

  // Studies listing (simple)
  const studyKeys = Object.keys(studies);
  if (!studyKeys.length) {
    studiesListEl.innerHTML = '<div class="small-muted">No studies loaded</div>';
    seriesListEl.innerHTML = '<div class="small-muted">No series available</div>';
    return;
  }

  let sHtml = '';
  studyKeys.forEach(suid => {
    const st = studies[suid];
    sHtml += `<div style="padding:8px;border:1px solid #3a3a3a;border-radius:6px;margin-bottom:8px;cursor:pointer" onclick="onStudyClick('${suid}')">
      <div style="font-weight:600">${st.patientName}</div>
      <div class="small-muted">${st.studyDate || ''}</div>
      <div class="small-muted" style="margin-top:4px">Series: ${Object.keys(st.series).length}</div>
    </div>`;
  });
  studiesListEl.innerHTML = sHtml;

  // Series listing for currentStudyUID (if set)
  if (!currentStudyUID) {
    // pick first
    currentStudyUID = studyKeys[0];
  }
  renderSeriesForStudy(currentStudyUID);
}

function onStudyClick(studyUID) {
  currentStudyUID = studyUID;
  renderSeriesForStudy(studyUID);
}

function renderSeriesForStudy(studyUID) {
  const seriesListEl = document.getElementById('seriesList');
  const st = studies[studyUID];
  if (!st) {
    seriesListEl.innerHTML = '<div class="small-muted">No series</div>';
    return;
  }
  const seriesKeys = Object.keys(st.series);
  if (!seriesKeys.length) {
    seriesListEl.innerHTML = '<div class="small-muted">No series</div>';
    return;
  }
  let html = '';
  seriesKeys.forEach((seUID, idx) => {
    const se = st.series[seUID];
    const activeClass = (seUID === currentSeriesUID) ? 'active' : '';
    html += `<div class="series-item ${activeClass}" onclick="selectSeries('${studyUID}','${seUID}')">
      <div style="font-weight:600">${se.seriesDesc || 'Series'}</div>
      <div class="small-muted" style="margin-top:6px">${se.images.length} images</div>
      <div class="small-muted" style="margin-top:6px">${seUID}</div>
    </div>`;
  });
  seriesListEl.innerHTML = html;
}

// ---------------------
// Select & load a series (load images into cornerstone)
// ---------------------
async function selectSeries(studyUID, seriesUID) {
  if (!studies[studyUID] || !studies[studyUID].series[seriesUID]) return;
  currentStudyUID = studyUID;
  currentSeriesUID = seriesUID;

  // update UI selection highlight
  renderSeriesForStudy(studyUID);

  // get images array (has imageId and file)
  const seriesObj = studies[studyUID].series[seriesUID];
  // sort by instance number
  seriesObj.images.sort((a,b) => (a.instance || 0) - (b.instance || 0));

  // Load all images for this series (cornerstone.loadImage using stored imageId)
  showLoading(true);
  try {
    const loadPromises = seriesObj.images.map(imgInfo => {
      if (!imgInfo.imageId) {
        // if for some reason imageId missing, add the file now
        try {
          imgInfo.imageId = cornerstoneWADOImageLoader.wadouri.fileManager.add(imgInfo.file);
        } catch (e) {}
      }
      return cornerstone.loadImage(imgInfo.imageId);
    });

    const images = await Promise.all(loadPromises);
    // store loaded images for navigation
    currentSeriesImages = images;
    currentSliceIndex = 0;

    // UI updates (study/series info)
    const sample = images[0];
    document.getElementById('patientName').textContent = (sample.data && sample.data.string('x00100010')) || studies[studyUID].patientName || 'Unknown';
    document.getElementById('studyDate').textContent = (sample.data && sample.data.string('x00080020')) || studies[studyUID].studyDate || 'Unknown';
    document.getElementById('seriesDescription').textContent = sample.data?.string('x0008103e') || seriesObj.seriesDesc || 'Series';

    // show first image
    displaySlice(0);

    // show/hide slider
    setupSliceNavigation();

    // set wheel tool appropriately
    safeSetWheelToolForSeries();
  } catch (err) {
    console.error('Error loading series images', err);
    alert('Error loading series images: ' + (err.message || err));
  } finally {
    showLoading(false);
  }
}

// ---------------------
// Display slice & slice navigation
// ---------------------
function displaySlice(index) {
  if (!currentSeriesImages.length || index < 0 || index >= currentSeriesImages.length) return;
  currentSliceIndex = index;
  const image = currentSeriesImages[index];
  cornerstone.displayImage(element, image);
  document.getElementById('currentSlice').textContent = index + 1;
  document.getElementById('sliceSlider').value = index;
  updatePatientInfo(image);
  element.focus();
}

function setupSliceNavigation() {
  const nav = document.getElementById('sliceNavigation');
  const slider = document.getElementById('sliceSlider');
  const total = document.getElementById('totalSlices');

  if (currentSeriesImages.length > 1) {
    nav.classList.remove('hidden');
    slider.max = currentSeriesImages.length - 1;
    slider.value = currentSliceIndex;
    total.textContent = currentSeriesImages.length;
  } else {
    nav.classList.add('hidden');
  }
}

function updatePatientInfo(image) {
  document.getElementById('patientName').textContent = image.data?.string('x00100010') || 'Unknown';
  document.getElementById('studyDate').textContent = image.data?.string('x00080020') || 'Unknown';
  document.getElementById('seriesDescription').textContent = image.data?.string('x0008103e') || 'Unknown';
}

function nextSlice(){ if (currentSliceIndex < currentSeriesImages.length - 1) displaySlice(currentSliceIndex + 1); }
function previousSlice(){ if (currentSliceIndex > 0) displaySlice(currentSliceIndex - 1); }

// ---------------------
// Viewport info update
// ---------------------
function onImageRendered() {
  try {
    const vp = cornerstone.getViewport(element);
    document.getElementById('windowWidth').textContent = Math.round(vp.voi.windowWidth || 0);
    document.getElementById('windowLevel').textContent = Math.round(vp.voi.windowCenter || 0);
    document.getElementById('zoomLevel').textContent = Math.round((vp.scale || 1) * 100) + '%';
  } catch (e) {}
}

function onNewImage() { safeSetWheelToolForSeries(); }

// ---------------------
// Set tool from toolbar
// ---------------------
function setTool(toolName) {
  try {
    ['Wwwc','Zoom','Pan'].forEach(t => { try { cornerstoneTools.setToolPassive(t); } catch(e){} });
    cornerstoneTools.setToolActive(toolName, { mouseButtonMask: 1 });
    if (currentSeriesImages.length > 1) cornerstoneTools.setToolActive('StackScrollMouseWheel', {});
    else cornerstoneTools.setToolActive('ZoomMouseWheel', {});
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    const elBtn = document.getElementById(toolName.toLowerCase() + 'Tool');
    if (elBtn) elBtn.classList.add('active');
    element.focus();
  } catch (e) {
    console.error('setTool error', e);
  }
}

// ---------------------
// Transform controls
// ---------------------
function resetViewport() {
  if (!currentSeriesImages.length) return;
  const img = currentSeriesImages[currentSliceIndex];
  const vp = cornerstone.getDefaultViewportForImage(element, img);
  cornerstone.setViewport(element, vp);
}
function fitToWindow() { try { cornerstone.fitToWindow(element); } catch(e){} }
function rotateImage() { try { const vp = cornerstone.getViewport(element); vp.rotation = (vp.rotation||0) + 90; cornerstone.setViewport(element, vp); } catch(e){} }
function flipHorizontal() { try { const vp = cornerstone.getViewport(element); vp.hflip = !vp.hflip; cornerstone.setViewport(element, vp); } catch(e){} }
function flipVertical() { try { const vp = cornerstone.getViewport(element); vp.vflip = !vp.vflip; cornerstone.setViewport(element, vp); } catch(e){} }
function invertImage() { try { const vp = cornerstone.getViewport(element); vp.invert = !vp.invert; cornerstone.setViewport(element, vp); } catch(e){} }

function applyPreset(name) {
  const presets = {
    CT_BONE: { windowWidth:2000, windowCenter:300 },
    CT_LUNG: { windowWidth:1500, windowCenter:-600 },
    CT_SOFT_TISSUE: { windowWidth:400, windowCenter:40 },
    CT_ABDOMEN: { windowWidth:350, windowCenter:50 }
  };
  const preset = presets[name];
  if (!preset) return;
  try {
    const vp = cornerstone.getViewport(element);
    vp.voi.windowWidth = preset.windowWidth;
    vp.voi.windowCenter = preset.windowCenter;
    cornerstone.setViewport(element, vp);
  } catch(e){}
}

// ---------------------
// Helpers
// ---------------------
function showLoading(show) { const l = document.getElementById('loading'); l.classList.toggle('hidden', !show); }

// ---------------------
// Init
// ---------------------
window.addEventListener('load', () => {
  initializeCornerstone();
  console.log('cornerstoneTools present?', !!window.cornerstoneTools);
  console.log('cornerstoneTools.globalConfiguration', window.cornerstoneTools && window.cornerstoneTools.globalConfiguration);
});

// Expose some globals used by inline attributes
window.setTool = setTool;
window.resetViewport = resetViewport;
window.fitToWindow = fitToWindow;
window.rotateImage = rotateImage;
window.flipHorizontal = flipHorizontal;
window.flipVertical = flipVertical;
window.invertImage = invertImage;
window.applyPreset = applyPreset;
window.previousSlice = previousSlice;
window.nextSlice = nextSlice;
window.loadSeries = selectSeries;
window.handleFileSelect = (e) => { const files = Array.from(e.target.files||[]).filter(f => isAllowedDicomFile(f.name)); if(files.length) ingestFiles(files); };

// ---------------------
// Manual fallback interactions (same as before) — optional but kept for reliability
// ---------------------
(function installFallback() {
  const el = document.getElementById('dicomElement'); if (!el) return;

  if (!window.currentSeriesImages) window.currentSeriesImages = currentSeriesImages;
  if (typeof nextSlice === 'function' && !window.nextSlice) window.nextSlice = nextSlice;
  if (typeof previousSlice === 'function' && !window.previousSlice) window.previousSlice = previousSlice;

  // Sensitivity params (tune these)
  let PAN_MULTIPLIER = 0.45;
  let ZOOM_SENSITIVITY = 0.0035;
  let WW_SENSITIVITY = 0.28;

  let manualTool = 'Wwwc';
  let dragging = false;
  let start = { x:0, y:0 };
  let startViewport = null;

  function getViewport(){ try { return cornerstone.getViewport(el); } catch(e) { return null; } }
  function setViewport(vp){ try { cornerstone.setViewport(el,vp); } catch(e){} }

  window.setActiveManualTool = function(name) { manualTool = name; console.log('Manual tool:', name); };

  el.addEventListener('mousedown', function(e){
    if (e.button !== 0) return;
    dragging = true;
    start.x = e.clientX; start.y = e.clientY;
    startViewport = getViewport();
    el.style.cursor = manualTool === 'Pan' ? 'grabbing' : 'ns-resize';
    e.preventDefault();
  }, { passive:false });

  window.addEventListener('mousemove', function(e){
    if (!dragging || !startViewport) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const vp = Object.assign({}, startViewport);

    if (manualTool === 'Zoom') {
      const amount = -dy * ZOOM_SENSITIVITY;
      const newScale = Math.max(0.02, (startViewport.scale || 1) * Math.exp(amount));
      vp.scale = newScale;
      setViewport(vp);
    } else if (manualTool === 'Pan') {
      vp.translation = vp.translation || {x:0,y:0};
      vp.translation.x = (startViewport.translation?.x || 0) + dx * PAN_MULTIPLIER;
      vp.translation.y = (startViewport.translation?.y || 0) + dy * PAN_MULTIPLIER;
      setViewport(vp);
    } else {
      vp.voi = vp.voi || {};
      const startW = startViewport.voi?.windowWidth ?? 400;
      const startC = startViewport.voi?.windowCenter ?? 40;
      vp.voi.windowWidth = Math.max(1, Math.round(startW + dx * WW_SENSITIVITY));
      vp.voi.windowCenter = Math.round(startC + dy * WW_SENSITIVITY);
      setViewport(vp);
    }

    e.preventDefault();
  }, { passive:false });

  window.addEventListener('mouseup', function(e){
    if (dragging) { dragging = false; startViewport = null; el.style.cursor='default'; }
  });

  el.addEventListener('wheel', function(e){
    e.preventDefault();
    const dir = Math.sign(e.deltaY);
    const series = currentSeriesImages || [];
    if (series.length > 1 && typeof window.nextSlice === 'function' && typeof window.previousSlice === 'function') {
      if (dir > 0) window.nextSlice(); else window.previousSlice();
      return;
    }
    const vp = getViewport(); if (!vp) return;
    const scale = vp.scale || 1;
    const newScale = Math.max(0.02, scale * (dir > 0 ? 0.9 : 1.1));
    vp.scale = newScale; setViewport(vp);
  }, { passive:false });

  const originalSetTool = window.setTool;
  window.setTool = function(toolName) {
    try { if (typeof originalSetTool === 'function') originalSetTool(toolName); } catch(e){}
    if (/Wwwc/i.test(toolName)) setActiveManualTool('Wwwc');
    else if (/Zoom/i.test(toolName)) setActiveManualTool('Zoom');
    else if (/Pan/i.test(toolName)) setActiveManualTool('Pan');
    else setActiveManualTool(toolName);
  };

  // read initial active button
  setTimeout(()=> {
    const active = document.querySelector('.tool-btn.active');
    if (active) {
      const id = active.id || '';
      if (id.toLowerCase().includes('wwwc')) setActiveManualTool('Wwwc');
      if (id.toLowerCase().includes('zoom')) setActiveManualTool('Zoom');
      if (id.toLowerCase().includes('pan')) setActiveManualTool('Pan');
    }
  },50);

  console.log('Fallback interactions installed');
})();
