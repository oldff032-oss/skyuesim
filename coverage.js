// Live package coverage from the server-side eSIM Access connection.
(() => {
  const codes = { 'Польща':'PL', 'Німеччина':'DE', 'Франція':'FR', 'Італія':'IT', 'Іспанія':'ES', 'Чехія':'CZ', 'Австрія':'AT', 'Нідерланди':'NL', 'Португалія':'PT', 'Греція':'GR', 'Румунія':'RO', 'Угорщина':'HU' };
  const start = () => {
    const requestedSection = window.location.hash.slice(1);
    const sections = [...document.querySelectorAll('.tool')];
    if (requestedSection && sections.some((section) => section.id === requestedSection)) {
      sections.forEach((section) => { section.style.display = section.id === requestedSection ? 'block' : 'none'; });
      const title = document.querySelector('.wrap > h1');
      const lead = document.querySelector('.wrap > .lead');
      const selectedTitle = document.querySelector(`#${requestedSection} h2`)?.textContent || '';
      if (title) title.textContent = selectedTitle.replace(/^\S+\s*/, '');
      if (lead) lead.innerHTML = '<a href="profile.html" style="color:var(--cyan);text-decoration:none;">← Повернутися до профілю</a>';
    }
    const select = document.getElementById('country');
    if (!select) return;
    [...select.options].forEach((option) => { if (codes[option.textContent]) option.value = codes[option.textContent]; });
    window.saveTravel = async () => {
      const location = select.value;
      const country = select.options[select.selectedIndex].textContent;
      const output = document.getElementById('travelResult');
      const token = localStorage.getItem('signal_session_token');
      localStorage.setItem('signal_travel_country', location);
      output.textContent = 'Отримуємо актуальне покриття eSIM Access...';
      try {
        const response = await fetch(`${API_URL}/api/account/coverage?location=${encodeURIComponent(location)}`, { headers: { 'x-session-token': token } });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        const packages = data.packages || [];
        if (!packages.length) { output.textContent = `${country}: доступних пакетів не знайдено.`; return; }
        output.innerHTML = `<b>${country}: доступно ${packages.length} пакетів</b><br>${packages.slice(0, 4).map((item) => `${item.name || item.packageCode} · код: <b>${item.packageCode}</b> · ${item.speed || 'мережа уточнюється'} · ${item.duration || '—'} ${item.durationUnit || ''}`).join('<br>')}<br><span class="muted">Дані отримано безпосередньо з eSIM Access.</span>`;
      } catch (error) {
        output.textContent = error.message || 'Не вдалося отримати покриття.';
      }
    };
    const remembered = localStorage.getItem('signal_travel_country');
    if (remembered && [...select.options].some((option) => option.value === remembered)) {
      select.value = remembered;
      window.saveTravel();
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
