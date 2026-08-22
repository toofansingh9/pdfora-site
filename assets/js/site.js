/* nav toggle + homepage tool search */
(function () {
  var btn = document.querySelector(".menu-btn");
  var nav = document.querySelector(".nav");
  if (btn && nav) btn.addEventListener("click", function () { nav.classList.toggle("open"); });

  // If the inline nav doesn't fit (long labels in some languages), fall back to the hamburger.
  function fitNav() {
    if (!nav) return;
    document.body.classList.remove("nav-tight");
    if (nav.offsetParent !== null && nav.scrollWidth > nav.clientWidth + 4) {
      document.body.classList.add("nav-tight");
    }
  }
  fitNav();
  window.addEventListener("resize", fitNav);

  var search = document.getElementById("toolsearch");
  if (search) {
    var cards = [].slice.call(document.querySelectorAll(".tool-card"));
    var cats = [].slice.call(document.querySelectorAll(".cat"));
    var none = document.querySelector(".no-results");
    search.addEventListener("input", function () {
      var q = search.value.trim().toLowerCase();
      var any = false;
      cards.forEach(function (c) {
        var hit = c.getAttribute("data-search").indexOf(q) > -1;
        c.style.display = hit ? "" : "none";
        if (hit) any = true;
      });
      cats.forEach(function (cat) {
        var vis = cat.querySelectorAll('.tool-card:not([style*="none"])').length;
        cat.style.display = vis ? "" : "none";
      });
      if (none) none.style.display = any ? "none" : "block";
    });
  }
})();
