from django.contrib import admin
from .models import SongProject, Section, Measure

class SectionInline(admin.TabularInline):
    model = Section
    extra = 0

class MeasureInline(admin.TabularInline):
    model = Measure
    extra = 0

@admin.register(SongProject)
class SongProjectAdmin(admin.ModelAdmin):
    list_display = ('id', 'title', 'default_key', 'bpm', 'total_measures', 'created_at', 'updated_at')
    search_fields = ('title',)
    inlines = [SectionInline, MeasureInline]