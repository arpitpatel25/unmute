// The compare pages: the menu-bar notch takes you to the demo, and the two
// ways play in when seen.
document.querySelector('.page-notch')?.addEventListener('click', () => { location.href = 'v4.html#try' })
const ways = document.querySelector('.ways')
if (ways) new IntersectionObserver(([e], o) => { if (e.isIntersecting) { ways.classList.add('in'); o.disconnect() } }, { threshold: 0.35 }).observe(ways)
