library(jsonlite)
library(dplyr)

source("load_data.R")

# Common USPS street-suffix abbreviations and cardinal directions, used to
# trim house numbers, leading direction prefixes (e.g. "N Main St" -> "Main St"),
# and trailing unit/direction tokens (e.g. "Lake Forest Dr E", "Ave #205") down
# to a bare street name.
SUFFIXES <- toupper(c("Ave","St","Rd","Dr","Blvd","Ct","Ln","Way","Pl","Cir","Ter",
  "Pkwy","Hwy","Trl","Loop","Path","Row","Sq","Xing","Walk","Run","Bnd","Cv","Grv",
  "Hl","Hls","Knl","Mnr","Pt","Pts","Rdg","Vw","Vlg","Aly","Byp","Cor","Cres","Ext",
  "Gdns","Hts","Jct","Ldg","Mdw","Mdws","Pike","Plz","Spg","Spgs","Sta","Vly","Vis","Grn"))
DIRECTIONS <- c("N","S","E","W","NE","NW","SE","SW")

extract_street <- function(homecode_html) {
  parts <- strsplit(homecode_html, "<br>")[[1]]
  line1 <- parts[1]; line2 <- parts[2]
  # A handful of entries put a building/place name on line1 (e.g. "Darling
  # Building") and the real house number ends up on line2 instead.
  street_line <- if (grepl("^\\d", line1)) {
    line1
  } else if (grepl("^\\d", line2)) {
    trimws(strsplit(line2, ",")[[1]][1])
  } else {
    line1
  }
  tokens <- strsplit(trimws(street_line), "\\s+")[[1]]
  if (length(tokens) <= 1) return(NA_character_)
  tokens <- tokens[-1]  # drop house number
  if (length(tokens) > 1 && toupper(tokens[1]) %in% DIRECTIONS) {
    tokens <- tokens[-1]  # drop leading direction (N/S/E/W)
  }
  if (length(tokens) == 0) return(NA_character_)
  suffix_idx <- which(toupper(tokens) %in% SUFFIXES)
  if (length(suffix_idx) > 0) {
    tokens <- tokens[1:max(suffix_idx)]  # drop trailing unit/direction after the suffix
  }
  paste(tokens, collapse = " ")
}

homecodes$street <- sapply(raw$homecodes, function(x) extract_street(x$homecode))
homecodes$city <- sapply(raw$homecodes, function(x) {
  trimws(strsplit(strsplit(x$homecode, "<br>")[[1]][2], ",")[[1]][1])
})

# Grouped by (street, city) since common names like Liberty St / Huron St /
# Washington St exist in both Ann Arbor and Ypsilanti.
street_city_counts <- homecodes %>%
  count(street, city, name = "num_signs") %>%
  arrange(desc(num_signs))
