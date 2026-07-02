library(jsonlite)
library(dplyr)
library(tidyr)

raw <- fromJSON("summer_game_2026_raw.json", simplifyDataFrame = FALSE)

homecodes <- bind_rows(lapply(raw$homecodes, function(x) {
  tibble(
    code_id = x$code_id,
    address = gsub("<br>", ", ", x$homecode, fixed = TRUE),
    lat = as.numeric(x$lat),
    lon = as.numeric(x$lon),
    display = as.integer(x$display),
    created = as.POSIXct(as.numeric(x$created), origin = "1970-01-01", tz = "America/Detroit"),
    num_redemptions = as.integer(x$num_redemptions),
    layer_group = x$layerGroup,
    num_reports = length(x$reports)
  )
}))

bizcodes <- bind_rows(lapply(raw$bizcodes, function(x) {
  tibble(
    code_id = x$code_id,
    business = gsub("<br>", ", ", x$bizcode, fixed = TRUE),
    lat = as.numeric(x$lat),
    lon = as.numeric(x$lon),
    created = as.POSIXct(as.numeric(x$created), origin = "1970-01-01", tz = "America/Detroit"),
    num_redemptions = as.integer(x$num_redemptions)
  )
}))

badges <- bind_rows(lapply(raw$badges, function(x) {
  tibble(
    popup = x$popup,
    lat = as.numeric(x$lat),
    lon = as.numeric(x$lon),
    image = x$image
  )
}))

cat(sprintf("homecodes: %d rows\nbizcodes: %d rows\nbadges: %d rows\n",
            nrow(homecodes), nrow(bizcodes), nrow(badges)))
