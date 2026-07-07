/* =====================================================================
 * Knowledge Galaxy — user config
 * ---------------------------------------------------------------------
 * Map each top-level folder name to a planet style. Keys MUST match the
 * folder names in your vault exactly (the same names that appear in
 * data.js). Anything you don't list here still shows up automatically
 * with an auto-assigned color from the palette below.
 *
 *   sub   : short subtitle under the folder name (any language)
 *   color : hex; tints the label, glow, atmosphere arc and ring
 *   ring  : true to give the planet Saturn-style rings
 *   desc  : one line shown in the side panel when you open the planet
 *   boost : (optional) emissive multiplier for dark textures, e.g. 1.1
 *   tex   : (optional) override texture key; defaults to the folder name
 *
 * To use your own planet art: drop a 2:1 equirectangular image named
 * <FolderName>.jpg into textures/ and run scripts/embed_textures.py.
 * ===================================================================== */
window.GALAXY_CONFIG = {
  title: "KNOWLEDGE GALAXY",   // big header
  subtitle: "YOUR  SECOND  BRAIN  AS  A  UNIVERSE",
  quote: "Per aspera ad astra",
  quoteBy: "through hardship to the stars",

  // Folder -> planet style. Demo set below uses the PARA method names.
  style: {
    "01_Projects":  {sub:"Active work",       color:"#4cc3ff", ring:true,  desc:"Things you are actively pushing forward with a deadline or goal."},
    "02_Areas":     {sub:"Ongoing",           color:"#2f6df6", ring:false, desc:"Long-running responsibilities you maintain over time."},
    "03_Resources": {sub:"Reference",         color:"#a855f7", ring:false, desc:"Topics and material you collect for future use."},
    "04_Archive":   {sub:"Cold storage",      color:"#ed8936", ring:false, desc:"Finished or inactive items, kept for the record."},
    "05_Journal":   {sub:"Daily notes",       color:"#4ade80", ring:false, desc:"Your day-by-day log, reflections and logs."},
    "06_Ideas":     {sub:"Sparks",            color:"#fbbf24", ring:true,  desc:"Raw ideas and drafts waiting to grow into something."},
    "07_Reading":   {sub:"Books & notes",     color:"#ff6a3d", ring:false, desc:"Highlights and notes from what you read."},
    "08_Inbox":     {sub:"Quick capture",     color:"#c9d7ea", ring:false, boost:1.1, desc:"Everything lands here first, then gets sorted out."},
  },

  // Auto-assigned colors for any folder not listed in `style` above.
  palette: ["#7dd3fc", "#a855f7", "#4ade80", "#fbbf24", "#ff6a3d",
            "#2f6df6", "#5eead4", "#f472b6", "#c084fc", "#34d399"],
};
