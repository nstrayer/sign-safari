# High-resolution static heatmap: Summer Game sign density over a real
# basemap, for close-up zooming/exploration (companion to the interactive
# map and fig-heatmap in street_concentration.qmd).

library(jsonlite)
library(dplyr)
library(sf)
library(terra)
library(maptiles)
library(ggplot2)

# ---- Load + filter data ----------------------------------------------

raw <- fromJSON("summer_game_2026_raw.json", simplifyDataFrame = FALSE)

homecodes <- bind_rows(lapply(raw$homecodes, function(x) {
  tibble(
    code_id = x$code_id,
    city = trimws(strsplit(strsplit(x$homecode, "<br>")[[1]][2], ",")[[1]][1]),
    lat = as.numeric(x$lat),
    lon = as.numeric(x$lon)
  )
}))

aa <- homecodes %>%
  filter(city == "Ann Arbor", lat > 41.5, lat < 43.5, lon > -85, lon < -83)

cat(sprintf("aa signs: %d\n", nrow(aa)))

# ---- Project to Web Mercator (EPSG:3857) -------------------------------
# Basemap tiles are natively in this projection, so working in it lets the
# density grid line up pixel-for-pixel with the tile raster (no separate
# reprojection step needed when compositing later).

aa_sf <- st_as_sf(aa, coords = c("lon", "lat"), crs = 4326) %>% st_transform(3857)
aa_xy <- st_coordinates(aa_sf)
aa$x <- aa_xy[, 1]
aa$y <- aa_xy[, 2]

# ---- Density grid: signs within a 400m (~5 min walk) radius -----------
# Same moving-window-count approach as fig-heatmap in the qmd, just at a
# finer grid spacing since this version is meant to be zoomed into.

radius <- 400   # meters, ~5 minute walk
grid_res <- 15  # meters -- finer than the qmd's 50m for a high-res render
buffer <- 200

gx <- seq(min(aa$x) - buffer, max(aa$x) + buffer, by = grid_res)
gy <- seq(min(aa$y) - buffer, max(aa$y) + buffer, by = grid_res)
grid <- expand.grid(x = gx, y = gy)

px <- aa$x; py <- aa$y
p_sq <- px^2 + py^2
chunk_size <- 5000
counts <- numeric(nrow(grid))
for (start in seq(1, nrow(grid), by = chunk_size)) {
  end <- min(start + chunk_size - 1, nrow(grid))
  gxc <- grid$x[start:end]; gyc <- grid$y[start:end]
  cross <- gxc %*% t(px) + gyc %*% t(py)
  d2 <- outer(gxc^2 + gyc^2, rep(1, length(px))) +
    matrix(p_sq, nrow = length(gxc), ncol = length(px), byrow = TRUE) - 2 * cross
  counts[start:end] <- rowSums(d2 <= radius^2)
}
grid$count <- counts

cat(sprintf("grid: %d points, max count %d\n", nrow(grid), max(grid$count)))

# ---- Top 5 hotspots (greedy pick + suppress within 2x radius) ---------

find_top_hotspots <- function(grid, n = 5, suppress_radius = 2 * radius) {
  remaining <- grid
  hotspots <- list()
  for (i in seq_len(n)) {
    best <- remaining[which.max(remaining$count), ]
    hotspots[[i]] <- best
    d <- sqrt((remaining$x - best$x)^2 + (remaining$y - best$y)^2)
    remaining <- remaining[d > suppress_radius, ]
  }
  bind_rows(hotspots)
}

top5 <- find_top_hotspots(grid, n = 5)

# ---- Basemap tiles (same style as the interactive leaflet map) --------

bbox_sf <- st_as_sfc(st_bbox(c(
  xmin = min(gx), xmax = max(gx), ymin = min(gy), ymax = max(gy)
), crs = st_crs(3857)))

# zoom 16 needs ~1,920 tiles here and is painfully slow to download; zoom 15
# + retina gives effectively the same pixel resolution (2x tiles) at 1/4 the
# tile count (~480) and still comes out to a 12,000 x 10,000px basemap.
basemap <- get_tiles(
  bbox_sf,
  provider = "CartoDB.Positron",
  zoom = 15,
  crop = TRUE,
  retina = TRUE
)

cat(sprintf("basemap: %d x %d px, %d layers\n", ncol(basemap), nrow(basemap), nlyr(basemap)))

# convert the tile raster to a plain R "raster" image object so ggplot can
# draw it with annotation_raster (avoids needing tidyterra, which conflicts
# with the dplyr version already loaded in this session)
basemap_full_ext <- ext(basemap)

# ---- Crop to the center of the map -------------------------------------
# The full download area extends well past where the signs actually cluster
# (buffer + outlying grid cells); keeping just the middle CROP_FRAC of each
# axis focuses the final image on where the action is.

CROP_FRAC <- 0.5
half_margin <- (1 - CROP_FRAC) / 2
full_xrange <- c(basemap_full_ext$xmin, basemap_full_ext$xmax)
full_yrange <- c(basemap_full_ext$ymin, basemap_full_ext$ymax)
crop_xmin <- full_xrange[1] + half_margin * diff(full_xrange)
crop_xmax <- full_xrange[1] + (1 - half_margin) * diff(full_xrange)
crop_ymin <- full_yrange[1] + half_margin * diff(full_yrange)
crop_ymax <- full_yrange[1] + (1 - half_margin) * diff(full_yrange)

basemap_crop <- crop(basemap, ext(crop_xmin, crop_xmax, crop_ymin, crop_ymax))
basemap_img <- as.raster(as.array(basemap_crop) / 255)
basemap_ext <- ext(basemap_crop)

# ---- Composite plot: heatmap glow over the basemap --------------------
# Drop zero-count cells entirely (rather than setting fill = NA) so they're
# fully transparent -- scale_fill_viridis_c's na.value would otherwise paint
# them grey50. Alpha is mapped through count^2.2, not count directly, so
# isolated single-sign cells (count = 1) fade almost all the way into the
# basemap instead of showing up as flat grey discs -- only real clusters
# stand out.

in_crop <- function(x, y) {
  x >= crop_xmin & x <= crop_xmax & y >= crop_ymin & y <= crop_ymax
}

grid_plot <- grid[grid$count > 0 & in_crop(grid$x, grid$y), ]
grid_plot$alpha_val <- (grid_plot$count / max(grid_plot$count))^2.2
aa_crop <- aa[in_crop(aa$x, aa$y), ]
top5_crop <- top5[in_crop(top5$x, top5$y), ]

heatmap_plot <- ggplot() +
  annotation_raster(basemap_img,
    xmin = basemap_ext$xmin, xmax = basemap_ext$xmax,
    ymin = basemap_ext$ymin, ymax = basemap_ext$ymax) +
  geom_raster(data = grid_plot, aes(x = x, y = y, fill = count, alpha = alpha_val),
              interpolate = TRUE) +
  scale_fill_viridis_c(option = "inferno", name = "Signs within\n400m walk") +
  scale_alpha_continuous(range = c(0, 0.92), guide = "none") +
  geom_point(data = aa_crop, aes(x = x, y = y),
             color = "white", size = 0.5, alpha = 0.6, stroke = 0) +
  geom_point(data = top5_crop, aes(x = x, y = y),
             color = "cyan", shape = 4, size = 4, stroke = 1.4) +
  coord_fixed(xlim = c(basemap_ext$xmin, basemap_ext$xmax),
              ylim = c(basemap_ext$ymin, basemap_ext$ymax), expand = FALSE) +
  labs(title = "Where a 5-minute walk finds the most Summer Game signs",
       subtitle = "Color = number of signs within a 400m walk; x marks the top 5 distinct hotspots") +
  theme_void() +
  theme(plot.title = element_text(face = "bold", hjust = 0.5),
        plot.subtitle = element_text(hjust = 0.5))

# ---- Export at high resolution -----------------------------------------
# Match the (cropped) basemap's native pixel dimensions (no upscaling beyond
# the source tile detail) at a high dpi so it's crisp when zoomed into.

out_dpi <- 300
ggsave(
  "street_concentration_heatmap.png",
  plot = heatmap_plot,
  width = ncol(basemap_crop) / out_dpi,
  height = nrow(basemap_crop) / out_dpi,
  dpi = out_dpi,
  limitsize = FALSE
)

cat(sprintf("saved street_concentration_heatmap.png (%d x %d px)\n",
            ncol(basemap_crop), nrow(basemap_crop)))
