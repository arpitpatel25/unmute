// The compare pages: nav border on scroll, and the two ways play in when seen.
const nav = document.querySelector('.nav')
addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 8), { passive: true })
const ways = document.querySelector('.ways')
if (ways) new IntersectionObserver(([e], o) => { if (e.isIntersecting) { ways.classList.add('in'); o.disconnect() } }, { threshold: 0.35 }).observe(ways)
