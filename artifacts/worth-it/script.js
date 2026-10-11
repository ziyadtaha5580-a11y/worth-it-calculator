(() => {
  const form = document.querySelector("#purchase-form");
  const resultContent = document.querySelector("#result-content");
  const resultEmpty = document.querySelector("#result-empty");
  const resultStatus = document.querySelector("#result-status");
  const toast = document.querySelector("#toast");
  const savedList = document.querySelector("#saved-list");
  const storageKey = "worth-it-saved-calculations";
  let currentResult = null;
  let toastTimer;

  const fieldIds = ["item-name", "price", "currency", "category", "income", "expenses", "savings", "reserve", "hourly", "uses", "months"];
  const numberFormat = (value, currency, digits = 2) => new Intl.NumberFormat(undefined, {
    style: "currency", currency, minimumFractionDigits: digits === 0 ? 0 : 2, maximumFractionDigits: digits
  }).format(value);
  const cleanNumber = (value, digits = 1) => new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value);
  const el = (id) => document.getElementById(id);

  function readForm() {
    const data = new FormData(form);
    return {
      itemName: String(data.get("itemName") || "").trim(),
      price: Number(data.get("price")), currency: String(data.get("currency")),
      category: String(data.get("category")), income: Number(data.get("income")),
      expenses: Number(data.get("expenses")), savings: Number(data.get("savings")),
      reserve: Number(data.get("reserve")), hourly: data.get("hourly") === "" ? null : Number(data.get("hourly")),
      uses: Number(data.get("uses")), months: Number(data.get("months")),
      urgency: String(data.get("urgency") || "need")
    };
  }

  function clearValidation() {
    document.querySelectorAll(".field.invalid").forEach((field) => field.classList.remove("invalid"));
    document.querySelectorAll(".field-error").forEach((field) => { field.textContent = ""; });
    const errors = el("form-errors");
    errors.hidden = true;
    errors.replaceChildren();
  }

  function validate(values) {
    clearValidation();
    const issues = [];
    const required = [
      ["price", "Price"], ["income", "Take-home income"], ["expenses", "Essential expenses"],
      ["savings", "Current savings"], ["reserve", "Protected savings minimum"],
      ["uses", "Expected uses per month"], ["months", "Ownership months"]
    ];
    required.forEach(([name, label]) => {
      const input = form.elements[name];
      const raw = input.value.trim();
      if (!raw || !Number.isFinite(Number(raw))) issues.push({ name, message: `${label} is required and must be a valid number.` });
      else if (Number(raw) < 0) issues.push({ name, message: `${label} cannot be negative.` });
    });
    if (Number.isFinite(values.price) && values.price <= 0) issues.push({ name: "price", message: "Price must be greater than zero." });
    if (Number.isFinite(values.income) && values.income <= 0) issues.push({ name: "income", message: "Take-home income must be greater than zero." });
    if (Number.isFinite(values.uses) && values.uses <= 0) issues.push({ name: "uses", message: "Expected uses must be greater than zero." });
    if (Number.isFinite(values.months) && values.months <= 0) issues.push({ name: "months", message: "Ownership months must be greater than zero." });
    if (Number.isFinite(values.months) && values.months > 0 && !Number.isInteger(values.months)) {
      issues.push({ name: "months", message: "Ownership months must be a whole number." });
    }
    if (values.hourly !== null && (!Number.isFinite(values.hourly) || values.hourly <= 0)) {
      issues.push({ name: "hourly", message: "Hourly take-home pay must be greater than zero, or leave it blank." });
    }
    const totalUses = values.uses * values.months;
    if (Number.isFinite(values.uses) && Number.isFinite(values.months) && (!Number.isFinite(totalUses) || totalUses <= 0)) {
      issues.push({ name: "uses", message: "Expected total uses are too large to calculate. Check the monthly uses and ownership months." });
    }
    if (Number.isFinite(values.price) && Number.isFinite(totalUses) && totalUses > 0 && !Number.isFinite(values.price / totalUses)) {
      issues.push({ name: "price", message: "That price is too large to calculate a cost per use. Check the amount." });
    }
    if (values.hourly > 0 && Number.isFinite(values.price) && !Number.isFinite(values.price / values.hourly)) {
      issues.push({ name: "hourly", message: "Those values are too large to estimate work hours. Check the price and hourly pay." });
    }
    if (Number.isFinite(values.price) && Number.isFinite(values.income) && values.income > 0 && !Number.isFinite((values.price / values.income) * 100)) {
      issues.push({ name: "income", message: "Those values are too large to calculate a price-to-income percentage." });
    }
    const uniqueIssues = issues.filter((issue, index) => issues.findIndex((item) => item.name === issue.name) === index);
    uniqueIssues.forEach((issue) => {
      const input = form.elements[issue.name];
      const field = input.closest(".field");
      if (field) field.classList.add("invalid");
      const error = el(`${issue.name}-error`);
      if (error) error.textContent = issue.message;
    });
    if (uniqueIssues.length) {
      const errorBox = el("form-errors");
      const heading = document.createElement("strong");
      heading.textContent = "A quick check before we calculate:";
      const list = document.createElement("ul");
      uniqueIssues.forEach((issue) => {
        const item = document.createElement("li");
        item.textContent = issue.message;
        list.append(item);
      });
      errorBox.append(heading, list);
      errorBox.hidden = false;
      form.querySelector(".field.invalid input, .field.invalid select")?.focus();
      return false;
    }
    return true;
  }

  // This is a transparent, non-scientific estimate. Affordability uses price coverage
  // (100/75/50/25/0 points at 100%/75%/50%/25%/below 25%). Cost per use earns
  // 100/80/60/35/10 points at thresholds of 2/5/10/25 currency units. Monthly
  // frequency earns 100/80/60/40/20 points at 12/6/3/1/fewer-than-1 uses. Urgency is
  // Need it now = 100, Can wait a week = 75, Just want it = 45. Final weights
  // are affordability 40%, cost per use 25%, frequency 15%, and urgency 20%.
  function scoreParts(values, available, costPerUse) {
    const coverage = available / values.price;
    const affordability = coverage >= 1 ? 100 : coverage >= .75 ? 75 : coverage >= .5 ? 50 : coverage >= .25 ? 25 : 0;
    const cost = costPerUse <= 2 ? 100 : costPerUse <= 5 ? 80 : costPerUse <= 10 ? 60 : costPerUse <= 25 ? 35 : 10;
    const frequency = values.uses >= 12 ? 100 : values.uses >= 6 ? 80 : values.uses >= 3 ? 60 : values.uses >= 1 ? 40 : 20;
    const urgency = values.urgency === "need" ? 100 : values.urgency === "wait" ? 75 : 45;
    const total = Math.round(affordability * .4 + cost * .25 + frequency * .15 + urgency * .2);
    return { affordability, cost, frequency, urgency, total };
  }

  function suggest(values, computed) {
    const suggestions = [];
    if (computed.unaffordable) suggestions.push(`This could dip below your protected ${numberFormat(values.reserve, values.currency, 0)} reserve. Consider waiting until the purchase fits above that line.`);
    else if (computed.available < values.price * 1.25) suggestions.push("Your available cushion is close to the price. A little more breathing room could make this feel easier.");
    else suggestions.push("Your numbers leave a buffer above your protected savings. Keep that reserve intact when you decide.");
    if (computed.costPerUse > 10) suggestions.push(`At about ${numberFormat(computed.costPerUse, values.currency)} per use, a longer lifespan or more frequent use would improve the value.`);
    else suggestions.push(`At about ${numberFormat(computed.costPerUse, values.currency)} per use, think about whether that feels fair for the value you get.`);
    if (values.urgency === "want") suggestions.push("Since this feels like a want, try the seven-day rule before buying.");
    else if (values.urgency === "wait") suggestions.push("You already feel it can wait. Give the idea a week and see if it still earns a place in your budget.");
    else suggestions.push("If it meets a real need, compare a few options and make sure this price is the right fit.");
    return suggestions;
  }

  function calculate(values) {
    const surplus = values.income - values.expenses;
    const totalUses = values.uses * values.months;
    const costPerUse = values.price / totalUses;
    const available = Math.max(0, values.savings - values.reserve + surplus);
    const availableAfterPurchase = available - values.price;
    const projectedFunds = values.savings + surplus - values.price;
    const unaffordable = projectedFunds < values.reserve;
    const score = scoreParts(values, available, costPerUse);
    const hours = values.hourly > 0 ? values.price / values.hourly : null;
    return {
      values, surplus, totalUses, costPerUse, available, availableAfterPurchase, projectedFunds, unaffordable, score, hours,
      suggestions: suggest(values, { unaffordable, available, costPerUse }),
      createdAt: new Date().toISOString()
    };
  }

  function text(id, value) { el(id).textContent = value; }
  function showResult(result) {
    currentResult = result;
    const { values, score } = result;
    resultEmpty.hidden = true;
    resultContent.hidden = false;
    resultStatus.textContent = "CALCULATION READY";
    text("score-number", score.total);
    const title = score.total >= 75 ? "Looks Worth It" : score.total >= 45 ? "Think It Over" : "Probably Skip It";
    text("verdict-title", title);
    text("verdict-description", score.total >= 75
      ? "The numbers look encouraging. Make sure the purchase still feels right to you."
      : score.total >= 45
        ? "There are trade-offs here. Take a breath and decide what matters most."
        : "The numbers suggest a pause could serve you well. There is no rush to decide.");
    el("score-ring").setAttribute("aria-label", `Score ${score.total} out of 100`);
    const warning = el("warning-box");
    warning.hidden = !result.unaffordable;
    warning.textContent = result.unaffordable
      ? `Potentially unaffordable: after this purchase and one month of net monthly cash flow, your projected savings would be ${numberFormat(result.projectedFunds, values.currency)}, below your protected ${numberFormat(values.reserve, values.currency)} minimum. This flag is separate from the score.`
      : "";
    text("metric-use", numberFormat(result.costPerUse, values.currency));
    text("metric-total", `${cleanNumber(result.totalUses)} expected uses over ${cleanNumber(values.months, 0)} months`);
    text("metric-income", `${cleanNumber(values.price / values.income * 100)}%`);
    text("metric-hours", result.hours === null ? "Not added" : `${cleanNumber(result.hours)} hrs`);
    text("metric-hours-note", result.hours === null ? "Add hourly pay to estimate" : "of take-home work");
    text("metric-funds", numberFormat(result.availableAfterPurchase, values.currency));
    text("metric-surplus", `After one month · ${numberFormat(result.surplus, values.currency, 0)} net cash flow`);
    const components = [
      ["affordability", score.affordability], ["cost", score.cost],
      ["frequency", score.frequency], ["urgency", score.urgency]
    ];
    components.forEach(([key, value]) => {
      text(`score-${key}`, value);
      el(`bar-${key}`).style.width = `${value}%`;
    });
    const suggestionList = el("suggestion-list");
    suggestionList.replaceChildren();
    result.suggestions.forEach((suggestion) => {
      const li = document.createElement("li");
      li.textContent = suggestion;
      suggestionList.append(li);
    });
    el("save-button").textContent = "Save this result";
  }

  function formToValues(values) {
    fieldIds.forEach((id) => {
      const field = form.elements[id === "item-name" ? "itemName" : id];
      if (field) field.value = values[id === "item-name" ? "itemName" : id] ?? "";
    });
    const urgency = form.querySelector(`input[name="urgency"][value="${values.urgency}"]`);
    if (urgency) urgency.checked = true;
    el("hourly-currency").textContent = values.currency;
  }

  function syncHourlyCurrency() {
    el("hourly-currency").textContent = form.elements.currency.value;
  }

  function getSaved() {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) || "[]");
      return Array.isArray(value) ? value.filter((item) => item && item.values && item.score) : [];
    } catch {
      return [];
    }
  }

  function saveAll(items) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(items));
      return true;
    } catch {
      showToast("Couldn't save here. Your browser may have storage turned off.", true);
      return false;
    }
  }

  function renderSaved() {
    const items = getSaved();
    text("saved-count", items.length);
    savedList.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "saved-empty";
      empty.textContent = "Nothing saved yet. Save a result when you want to come back to it.";
      savedList.append(empty);
      return;
    }
    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "saved-item";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "saved-open";
      const title = document.createElement("strong");
      title.textContent = item.values.itemName || item.values.category || "Purchase calculation";
      const date = document.createElement("small");
      date.textContent = `${new Date(item.createdAt).toLocaleDateString()} · ${numberFormat(item.values.price, item.values.currency, 0)}`;
      open.append(title, date);
      open.addEventListener("click", () => { formToValues(item.values); showResult(item); document.querySelector("#result-card").scrollIntoView({ behavior: "smooth", block: "start" }); showToast("Saved calculation opened."); });
      const score = document.createElement("span");
      score.className = "saved-score";
      score.textContent = item.score.total;
      score.setAttribute("aria-label", `Score ${item.score.total}`);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "saved-delete";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Delete saved calculation ${item.values.itemName || item.values.category}`);
      remove.addEventListener("click", () => {
        if (saveAll(getSaved().filter((entry) => entry.id !== item.id))) {
          renderSaved();
          showToast("Saved calculation deleted.");
        }
      });
      row.append(open, score, remove);
      savedList.append(row);
    });
  }

  function showToast(message, isError = false) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.style.background = isError ? "#f1b6a9" : "";
    toast.classList.add("show");
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
  }

  function resultSummary(result) {
    const v = result.values;
    const verdict = result.score.total >= 75 ? "Looks Worth It" : result.score.total >= 45 ? "Think It Over" : "Probably Skip It";
    return [
      `Worth It? — ${v.itemName || v.category}`,
      `Result: ${verdict} (${result.score.total}/100)${result.unaffordable ? " · Potentially unaffordable" : ""}`,
      `Price: ${numberFormat(v.price, v.currency)} · ${cleanNumber(v.price / v.income * 100)}% of monthly take-home`,
      `Cost per use: ${numberFormat(result.costPerUse, v.currency)} over ${cleanNumber(result.totalUses)} estimated uses`,
      `Work time: ${result.hours === null ? "Not calculated" : `${cleanNumber(result.hours)} hours`}`,
      `Available after purchase: ${numberFormat(result.availableAfterPurchase, v.currency)} above the protected reserve`,
      `Projected savings after purchase and one month of net surplus: ${numberFormat(result.projectedFunds, v.currency)}`,
      `Score components — Affordability ${result.score.affordability}/100 (40%), cost/use ${result.score.cost}/100 (25%), monthly frequency ${result.score.frequency}/100 (15%), urgency ${result.score.urgency}/100 (20%).`,
      "An estimate based only on your inputs, not financial advice. Your information stays in your browser."
    ].join("\n");
  }

  async function copyText(value) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const temporary = document.createElement("textarea");
    temporary.value = value;
    temporary.setAttribute("readonly", "");
    temporary.style.position = "fixed";
    temporary.style.opacity = "0";
    document.body.append(temporary);
    temporary.select();
    const success = document.execCommand("copy");
    temporary.remove();
    if (!success) throw new Error("Clipboard unavailable");
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = readForm();
    if (!validate(values)) return;
    showResult(calculate(values));
    el("result-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  el("recalculate-button").addEventListener("click", () => form.requestSubmit());
  form.elements.currency.addEventListener("change", syncHourlyCurrency);
  el("example-button").addEventListener("click", () => {
    formToValues({
      itemName: "Wireless headphones", price: 289, currency: "CAD", category: "Technology",
      income: 4280, expenses: 2675, savings: 7420, reserve: 5000, hourly: 27.5,
      uses: 12, months: 24, urgency: "wait"
    });
    clearValidation();
    showToast("Example added. Adjust anything, then calculate.");
  });
  el("reset-button").addEventListener("click", () => {
    form.reset();
    syncHourlyCurrency();
    clearValidation();
    currentResult = null;
    resultContent.hidden = true;
    resultEmpty.hidden = false;
    resultStatus.textContent = "AWAITING INPUT";
    document.querySelectorAll(".bar-track span").forEach((bar) => { bar.style.width = "0"; });
    showToast("Current calculation cleared. Saved results are unchanged.");
  });
  el("save-button").addEventListener("click", () => {
    if (!currentResult) return;
    const items = getSaved();
    if (items.some((item) => item.id === currentResult.id)) {
      showToast("This result is already saved.");
      return;
    }
    const saved = { ...currentResult, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
    if (saveAll([saved, ...items].slice(0, 20))) {
      currentResult = saved;
      renderSaved();
      showToast("Result saved in this browser.");
    }
  });
  el("copy-button").addEventListener("click", async () => {
    if (!currentResult) return;
    try { await copyText(resultSummary(currentResult)); showToast("Results copied to your clipboard."); }
    catch { showToast("Couldn't access the clipboard. Try selecting and copying the result text.", true); }
  });
  el("share-button").addEventListener("click", async () => {
    if (!currentResult) return;
    const summary = resultSummary(currentResult);
    try {
      if (navigator.share) {
        await navigator.share({ title: "Worth It? — purchase decision", text: summary });
        showToast("Share sheet opened.");
      } else {
        await copyText(summary);
        showToast("Sharing isn't available here, so your result was copied instead.");
      }
    } catch (error) {
      if (error && error.name === "AbortError") return;
      try { await copyText(summary); showToast("Couldn't open sharing. Result copied instead."); }
      catch { showToast("Couldn't share or copy this result on this device.", true); }
    }
  });
  renderSaved();
})();
