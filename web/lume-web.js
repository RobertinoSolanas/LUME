/* lume-web.js – with live coordinate & POI panel + console logging */
(function(){
  const { wikiSummaryFlexible } = window;
  'use strict';

  /* ---------- Map setup ---------- */
  const map = L.map('map', { keyboard:true }).setView([51.1657,10.4515], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'© OpenStreetMap contributors', maxZoom:19 }).addTo(map);

  /* ---------- DOM refs ---------- */
  const sIn      = document.getElementById('start');
  const eIn      = document.getElementById('end');
  const routeBtn = document.getElementById('routeBtn');
  const goBtn    = document.getElementById('goBtn');
  const stepsUL  = document.getElementById('routeSteps');
  const playBtn  = document.getElementById('playRouteBtn');
  const distInfo = document.getElementById('distInfo');
  const poiList  = document.getElementById('poiList');

  /* ---------- Live info panel (left) ---------- */
  const liveBox = (()=>{
    const div = document.createElement('div');
    div.id = 'liveBox';
    div.style.cssText = 'position:absolute;top:140px;left:10px;z-index:1000;background:var(--bg);padding:.6rem .9rem;border-radius:var(--radius);box-shadow:var(--shadow);font-size:.85rem;line-height:1.4;';
    div.innerHTML = `<div><strong>Coord:</strong> <span id="liveCoord">–</span></div>
                     <div><strong>POI:</strong> <span id="livePoi">–</span></div>
                     <div><strong>Speed:</strong> <span id="liveSpeed">– km/h</span></div>`;
    document.body.appendChild(div);
    return div;
  })();
  const liveCoord = document.getElementById('liveCoord');
  const livePoi   = document.getElementById('livePoi');

  /* ---------- Speech helper ---------- */
  let routeSpeech='';
  function speak(t){ if(!('speechSynthesis' in window)) return; window.speechSynthesis.cancel(); const u=new SpeechSynthesisUtterance(t); u.lang='de-DE'; window.speechSynthesis.speak(u);}  
  playBtn.onclick = ()=> routeSpeech && speak(routeSpeech);

  /* ---------- Async helpers ---------- */
  async function geocode(q){ const r=await fetch(`https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&countrycodes=de&limit=1&q=${encodeURIComponent(q)}`,{headers:{Referer:'file://'}}); return r.json(); }
  async function fetchRoute(sl,so,el,eo){ const r=await fetch(`https://router.project-osrm.org/route/v1/cycling/${so},${sl};${eo},${el}?overview=full&geometries=geojson&steps=true`); if(!r.ok) throw new Error('route'); return r.json(); }
  const toC=async v=>/^-?\d+\.\d+,-?\d+\.\d+$/.test(v)?{lat:+v.split(',')[0],lon:+v.split(',')[1]}:(await geocode(v))[0]&&{lat:+(await geocode(v))[0].lat,lon:+(await geocode(v))[0].lon};
  const interp=(a,b,t)=>a+(b-a)*t; const sumDist=a=>a.reduce((d,_,i)=>i?d+a[i-1].distanceTo(a[i]):0,0);

  /* ---------- POI cache ---------- */
  const poiCache={}; async function fetchPOI(lat,lon){const k=lat.toFixed(4)+','+lon.toFixed(4); if(poiCache[k]!==undefined) return poiCache[k]; poiCache[k]=new Promise(async res=>{ const q=`[out:json][timeout:25];(node(around:300,${lat},${lon})["name"];way(around:300,${lat},${lon})["name"];);out body 1;`; try{const r=await fetch('https://overpass-api.de/api/interpreter?data='+encodeURIComponent(q)); if(!r.ok) throw''; const d=await r.json(); const n=d.elements[0]?.tags?.name||null; poiCache[k]=n; res(n); }catch{ poiCache[k]=null; res(null);} }); return poiCache[k];}

  /* ---------- State ---------- */
  let latlngs=[], total=0; let markerStart,markerEnd,line,nav; let upcomingPOIs={},poiIdxKm=0; const recentPOIs=[]; let poiMarkers=[];
  let isPlaying = false;
  let animFrame = null;
  let currentPosition = 0;

  async function renderPoiList(){
    poiList.innerHTML = '';
    const poiInfo = document.getElementById('poiInfo');
    
    for (const n of recentPOIs) {
      const li = document.createElement('li');
      li.textContent = n;
      li.style.cursor = 'pointer';
      li.onclick = async () => {
        try {
          poiInfo.innerHTML = 'Loading Wikipedia info...';
          const summary = await wikiSummaryFlexible('de', n);
          poiInfo.innerHTML = `<strong>${n}:</strong> ${summary}`;
        } catch (e) {
          poiInfo.innerHTML = `Couldn't load info for ${n}`;
        }
      };
      poiList.appendChild(li);
    }
    
    if (!recentPOIs.length) {
      poiList.innerHTML = '<li>No POIs yet</li>';
      poiInfo.innerHTML = '';
    }
  }
  function addPoiMarker(lat,lon,name){poiMarkers.push(L.circleMarker([lat,lon],{radius:4,color:'#1abc9c'}).addTo(map).bindPopup(name));}

  /* ---------- Pre‑sample POIs ---------- */
  async function preSamplePOIs(){ upcomingPOIs={}; poiMarkers.forEach(m=>map.removeLayer(m)); poiMarkers=[]; const samples=[]; let kmAcc=0; for(let i=0;i<latlngs.length-1;i++){ let a=latlngs[i],b=latlngs[i+1]; let seg=a.distanceTo(b),remain=seg,from=a; while(kmAcc+remain>=1000){const need=1000-kmAcc;const r=need/remain; const lat=from.lat+(b.lat-from.lat)*r; const lon=from.lng+(b.lng-from.lng)*r; samples.push({km:samples.length+1,lat,lon}); from=L.latLng(lat,lon); remain-=need; kmAcc=0;} kmAcc+=remain; }
    for(const s of samples){ fetchPOI(s.lat,s.lon).then(name=>{ if(name && !upcomingPOIs[s.km]){upcomingPOIs[s.km]=name; addPoiMarker(s.lat,s.lon,name);} }); await new Promise(r=>setTimeout(r,200)); }
  }

  /* ---------- Route button ---------- */
  routeBtn.onclick=async()=>{const s=sIn.value.trim(), t=eIn.value.trim(); if(!s||!t){alert('Enter start & destination'); return;} try{ const S=await toC(s), T=await toC(t); markerStart?.remove(); markerEnd?.remove(); markerStart=L.marker([S.lat,S.lon]).addTo(map); markerEnd=L.marker([T.lat,T.lon]).addTo(map); const data=await fetchRoute(S.lat,S.lon,T.lat,T.lon); latlngs=data.routes[0].geometry.coordinates.map(c=>L.latLng(c[1],c[0])); line?.remove(); line=L.polyline(latlngs,{color:'#FF5722',weight:4}).addTo(map); map.fitBounds(line.getBounds(),{padding:[30,30]}); total=sumDist(latlngs); distInfo.textContent=`Distance: ${(total/1000).toFixed(1)} km | left: ${(total/1000).toFixed(1)} km`; stepsUL.innerHTML=''; routeSpeech=''; data.routes[0].legs[0].steps.filter(st=>{const instr=st?.maneuver?.instruction||''; return instr.toLowerCase()!=='continue'&&(st.distance??0)>10000;}).forEach((st,i)=>{const li=document.createElement('li'); li.textContent=st.maneuver.instruction; stepsUL.appendChild(li); routeSpeech+=`${i+1}. ${li.textContent}. `;}); if(!stepsUL.childElementCount) stepsUL.innerHTML='<li>No major turns.</li>'; poiIdxKm=0; recentPOIs.length=0; renderPoiList(); preSamplePOIs(); goBtn.disabled=false; speak('Route ready. Press Go to start.'); }catch(e){console.warn(e); alert('Routing failed');}};

  /* ---------- Go/Stop button ---------- */
  goBtn.onclick = () => {
    if (latlngs.length < 2) return;
    
    if (!isPlaying) {
      // Start/resume navigation
      goBtn.textContent = 'Stop';
      goBtn.disabled = true;
      if (!nav) {
        nav = L.marker(latlngs[0], {
          icon: L.divIcon({className:'bikeIcon',html:'😃',iconSize:[30,30]})
        }).addTo(map);
        speak('Los geht\'s!');
        setTimeout(() => {
          nav.setIcon(L.divIcon({className:'bikeIcon',html:'🚲',iconSize:[30,30]}));
          map.setView(nav.getLatLng());
          isPlaying = true;
          animate();
        }, 1500);
      } else {
        isPlaying = true;
        animate();
      }
    } else {
      // Stop navigation
      goBtn.textContent = 'Go';
      isPlaying = false;
      cancelAnimationFrame(animFrame);
      animFrame = null;
      goBtn.disabled = false;
    }
  };

  /* ---------- Animation ---------- */
  function animate(){ 
    const speed=20.8; 
    let idx=0, segStart=latlngs[0], segEnd=latlngs[1]; 
    let segDist=segStart.distanceTo(segEnd), segDur=segDist/speed; 
    let segTS=null, traveled=0, lastUI=0, lastSpeedUpdate=0, currentSpeed=0;
    
    function frame(ts){ 
      if (!isPlaying) {
        cancelAnimationFrame(animFrame);
        return;
      }
      if(segTS===null) segTS=ts; let prog=(ts-segTS)/1000/segDur; while(prog>=1 && idx<latlngs.length-2){ traveled+=segDist; idx++; segStart=latlngs[idx]; segEnd=latlngs[idx+1]; segDist=segStart.distanceTo(segEnd); segDur=segDist/speed; segTS+=segDur*1000; prog=(ts-segTS)/1000/segDur; }
      if(idx>=latlngs.length-1){ nav.setLatLng(latlngs.at(-1)); map.panTo(latlngs.at(-1)); speak('Angekommen.'); distInfo.textContent=`Distance: ${(total/1000).toFixed(1)} km | left: 0 km`; goBtn.disabled=false; goBtn.textContent='Go'; isPlaying=false; nav=null; currentPosition=0; return; }
      prog=Math.max(0,Math.min(1,prog)); const lat=interp(segStart.lat,segEnd.lat,prog), lon=interp(segStart.lng,segEnd.lng,prog); nav.setLatLng([lat,lon]); map.panTo([lat,lon],{animate:false}); liveCoord.textContent=`${lat.toFixed(5)}, ${lon.toFixed(5)}`; console.log('Coord',lat,lon);
      const now=traveled+segDist*prog; 
      if(ts-lastSpeedUpdate>1000) {
        lastSpeedUpdate = ts;
        currentSpeed = speed * 3.6; // Convert m/s to km/h
        document.getElementById('liveSpeed').textContent = `${currentSpeed.toFixed(1)} km/h`;
      }
      if(ts-lastUI>5000){ lastUI=ts; distInfo.textContent=`Distance: ${(total/1000).toFixed(1)} km | left: ${((total-now)/1000).toFixed(1)} km`; }
      const kmCurr=Math.floor(now/1000); if(kmCurr>poiIdxKm){ poiIdxKm=kmCurr; const announce=n=>{ if(!n) return; recentPOIs.unshift(n); if(recentPOIs.length>3) recentPOIs.pop(); livePoi.textContent=n; console.log('POI',n); speak(`In der Nähe: ${n}`); renderPoiList(); };
        if(upcomingPOIs[kmCurr]) announce(upcomingPOIs[kmCurr]); else fetchPOI(lat,lon).then(n=>{ if(n){ upcomingPOIs[kmCurr]=n; announce(n);} }); }
      animFrame = requestAnimationFrame(frame);
    }
    // kick off
    animFrame = requestAnimationFrame(frame);
  }

})();
