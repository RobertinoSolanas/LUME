/* lume-web.js – full, fixed version */
(function(){
  'use strict';

  /* -------------------------------- Map -------------------------------- */
  const map = L.map('map', { keyboard:true }).setView([51.1657,10.4515], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'© OpenStreetMap contributors', maxZoom:19 }).addTo(map);

  /* ------------------------------ Elements ------------------------------ */
  const sIn      = document.getElementById('start');
  const eIn      = document.getElementById('end');
  const routeBtn = document.getElementById('routeBtn');
  const goBtn    = document.getElementById('goBtn');
  const stepsUL  = document.getElementById('routeSteps');
  const playBtn  = document.getElementById('playRouteBtn');
  const distInfo = document.getElementById('distInfo');
  const poiList  = document.getElementById('poiList');

  /* ------------------------------ Speech ------------------------------ */
  let routeSpeech='';
  function speak(t){
    if(!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(t);
    u.lang = 'de-DE';
    window.speechSynthesis.speak(u);
  }
  playBtn.onclick = () => routeSpeech && speak(routeSpeech);

  /* ------------------------------ Helpers ------------------------------ */
  async function geocode(q){
    const url=`https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&countrycodes=de&limit=1&q=${encodeURIComponent(q)}`;
    const r  = await fetch(url,{ headers:{ Referer:'file://' } });
    return r.json();
  }
  async function fetchRoute(sl,so,el,eo){
    const url=`https://router.project-osrm.org/route/v1/cycling/${so},${sl};${eo},${el}?overview=full&geometries=geojson&steps=true`;
    const r = await fetch(url); if(!r.ok) throw new Error('route');
    return r.json();
  }
  const toC = async v=>{
    if(/^-?\d+\.\d+,-?\d+\.\d+$/.test(v)){
      const [lat,lon]=v.split(',').map(Number); return {lat,lon};
    }
    const res = await geocode(v);
    if(!res.length) throw new Error('Geocode');
    return { lat:+res[0].lat, lon:+res[0].lon };
  };
  const interp=(a,b,t)=>a+(b-a)*t;
  const sumDist=a=>a.reduce((d,_,i)=> i? d+a[i-1].distanceTo(a[i]) : 0 ,0);

  /* ------------------------------ POI cache ------------------------------ */
  const poiCache = {}; // key -> name|null|Promise
  async function fetchPOI(lat,lon){
    const key = lat.toFixed(4)+','+lon.toFixed(4);
    if(poiCache[key]!==undefined) return poiCache[key];
    poiCache[key]=new Promise(async res=>{
      const q=`[out:json][timeout:25];(node(around:300,${lat},${lon})["name"];way(around:300,${lat},${lon})["name"];);out body 1;`;
      try{
        const r=await fetch('https://overpass-api.de/api/interpreter?data='+encodeURIComponent(q));
        if(!r.ok) throw'';
        const d = await r.json();
        const n = d.elements[0]?.tags?.name || null;
        poiCache[key]=n; res(n);
      }catch{ poiCache[key]=null; res(null);} });
    return poiCache[key];
  }

  /* ------------------------------ State ------------------------------ */
  let latlngs=[], total=0;
  let markerStart, markerEnd, line, nav;
  let upcomingPOIs={}, poiIdxKm=0;
  const recentPOIs=[]; // newest first, max 3
  let poiMarkers=[];

  /* ------------------------------ UI refresh ------------------------------ */
  function renderPoiList(){
    poiList.innerHTML='';
    recentPOIs.forEach(n=>{const li=document.createElement('li');li.textContent=n;poiList.appendChild(li);});
    if(!recentPOIs.length) poiList.innerHTML='<li>No POIs yet</li>';
  }
  function addPoiMarker(lat,lon,name){
    const m=L.circleMarker([lat,lon],{radius:4,color:'#1abc9c'}).addTo(map).bindPopup(name);
    poiMarkers.push(m);
  }

  /* ------------------------------ Pre‑sample POIs ------------------------------ */
  async function preSamplePOIs(){
    upcomingPOIs={}; poiMarkers.forEach(m=>map.removeLayer(m)); poiMarkers=[];
    poiList.innerHTML='<li>Loading…</li>';
    const samples=[]; let kmAcc=0;
    for(let i=0;i<latlngs.length-1;i++){
      let a=latlngs[i], b=latlngs[i+1];
      let seg=a.distanceTo(b), remain=seg, start=a;
      while(kmAcc+remain>=1000){
        const need=1000-kmAcc; const r=need/remain;
        const lat=start.lat+(b.lat-start.lat)*r;
        const lon=start.lng+(b.lng-start.lng)*r;
        samples.push({ km:samples.length+1, lat, lon });
        start=L.latLng(lat,lon); remain-=need; kmAcc=0;
      }
      kmAcc+=remain;
    }
    for(const s of samples){
      fetchPOI(s.lat,s.lon).then(name=>{
        if(name && !upcomingPOIs[s.km]){ upcomingPOIs[s.km]=name; addPoiMarker(s.lat,s.lon,name);} if(s.km<=3) renderPoiList(); });
      await new Promise(r=>setTimeout(r,200));
    }
  }

  /* ------------------------------ Route button ------------------------------ */
  routeBtn.onclick=async()=>{
    const s=sIn.value.trim(), t=eIn.value.trim(); if(!s||!t){ alert('Enter start & destination'); return; }
    try{
      const S=await toC(s), T=await toC(t);
      markerStart?.remove(); markerEnd?.remove();
      markerStart=L.marker([S.lat,S.lon]).addTo(map);
      markerEnd  =L.marker([T.lat,T.lon]).addTo(map);
      const data=await fetchRoute(S.lat,S.lon,T.lat,T.lon);
      latlngs = data.routes[0].geometry.coordinates.map(c=>L.latLng(c[1],c[0]));
      line?.remove(); line=L.polyline(latlngs,{color:'#FF5722',weight:4}).addTo(map);
      map.fitBounds(line.getBounds(),{padding:[30,30]});
      total = sumDist(latlngs);
      distInfo.textContent=`Distance: ${(total/1000).toFixed(1)} km | left: ${(total/1000).toFixed(1)} km`;
      // steps
      stepsUL.innerHTML=''; routeSpeech='';
      data.routes[0].legs[0].steps.filter(st=>{const instr=st?.maneuver?.instruction||''; return instr.toLowerCase()!=='continue'&&(st.distance??0)>10000;}).forEach((st,i)=>{const li=document.createElement('li');li.textContent=st.maneuver.instruction; stepsUL.appendChild(li); routeSpeech+=`${i+1}. ${li.textContent}. `;});
      if(!stepsUL.childElementCount) stepsUL.innerHTML='<li>No major turns.</li>';
      // reset POIs
      poiIdxKm=0; recentPOIs.length=0; renderPoiList(); preSamplePOIs();
      goBtn.disabled=false; speak('Route ready. Press Go to start.');
    }catch(e){ console.warn(e); alert('Routing failed'); }
  };

  /* ------------------------------ Go button ------------------------------ */
  goBtn.onclick=()=>{
    if(latlngs.length<2) return;
    goBtn.disabled=true;
    nav?.remove(); nav=L.marker(latlngs[0],{icon:L.divIcon({className:'bikeIcon',html:'😃',iconSize:[30,30]})}).addTo(map);
    speak('Los geht’s!');
    setTimeout(()=>{
      nav.setIcon(L.divIcon({className:'bikeIcon',html:'🚲',iconSize:[30,30]}));
      map.setView(nav.getLatLng());
      animate();
    },1500);
  };

  /* ------------------------------ Animation ------------------------------ */
  function animate(){
    const speed=20.8; // m/s (≈75 km/h)
    let idx=0, segStart=latlngs[0], segEnd=latlngs[1];
    let segDist=segStart.distanceTo(segEnd), segDur=segDist/speed;
    let segStartTS=null, traveled=0, lastUI=0;

    function frame(ts){
      if(segStartTS===null) segStartTS=ts;
      let prog=(ts-segStartTS)/1000/segDur;
      while(prog>=1 && idx<latlngs.length-2){
        traveled+=segDist;
        idx++;
        segStart=latlngs[idx]; segEnd=latlngs[idx+1]; segDist=segStart.distanceTo(segEnd); segDur=segDist/speed; segStartTS+=segDur*1000; prog=(ts-segStartTS)/1000/segDur;
      }
      if(idx>=latlngs.length-1){
        nav.setLatLng(latlngs.at(-1)); map.panTo(latlngs.at(-1)); speak('Angekommen.'); distInfo.textContent=`Distance: ${(total/1000).toFixed(1)} km | left: 0 km`; goBtn.disabled=false; return;
      }
      prog=Math.max(0,Math.min(1,prog));
      const lat=interp(segStart.lat,segEnd.lat,prog), lon=interp(segStart.lng,segEnd.lng,prog);
      nav.setLatLng([lat,lon]); map.panTo([lat,lon],{animate:false});
      const now=traveled+segDist*prog;
      if(ts-lastUI>5000){ lastUI=ts; distInfo.textContent=`Distance: ${(total/1000).toFixed(1)} km | left: ${((total-now)/1000).toFixed(1)} km`; }
      const kmCurr=Math.floor(now/1000);
      if(kmCurr>poiIdxKm){
        poiIdxKm=kmCurr;
        const announce=(name)=>{ if(!name) return; recentPOIs.unshift(name); if(recentPOIs.length>3) recentPOIs.pop(); speak(`In der Nähe: ${name}`); renderPoiList(); };
        if(upcomingPOIs[kmCurr]) announce(upcomingPOIs[kmCurr]); else fetchPOI(lat,lon).then(n=>{if(n){upcomingPOIs[kmCurr]=n; announce(n);}});
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
})();
