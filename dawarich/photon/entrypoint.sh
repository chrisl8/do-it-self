#!/bin/bash

# Download elasticsearch index
if [ ! -d "/photon/photon_data/elasticsearch" ]; then
    echo "Downloading search index"

    # Information about this download can be found here:
    # https://nominatim.org/2020/10/21/photon-country-extracts.html
    # The data is updated weekly, although I doubt much changes in the geocoding data for the areas I typically travel.
    # If you want to install a specific region only, enable the line below and disable the current 'wget' row.
    # Take a look at http://download1.graphhopper.com/public/extracts/by-country-code for your country
    # wget --user-agent="$USER_AGENT" -O - http://download1.graphhopper.com/public/extracts/by-country-code/nl/photon-db-nl-latest.tar.bz2 | bzip2 -cd | tar x
    wget --user-agent="$USER_AGENT" -O - http://download1.graphhopper.com/public/photon-db-latest.tar.bz2 | bzip2 -cd | tar x
fi

# Start photon if elastic index exists
if [ -d "/photon/photon_data/elasticsearch" ]; then
    echo "Start photon"
    java -jar photon.jar $@
else
    echo "Could not start photon, the search index could not be found"
fi
